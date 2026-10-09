/**
 * Ollama / OpenAI-compatible local endpoint provider (AGENTS.md `ai/ollama.ts`,
 * PLAN.md §4 priority-1 local backend).
 *
 * Talks to any OpenAI-compatible `/v1/chat/completions` server (Ollama,
 * llama.cpp server, LM Studio…). Suggested models are small + quantized
 * (`qwen3:0.6b`-class) — title rewriting + enum pick is a toy task, and the
 * local latency budget is ≤ 2 s (PLAN.md §1).
 */

import { StampTier } from "../stamps/types.js";
import type { AnalysisResult, BatchInput } from "./types.js";
import type { VideoSignal } from "../content/signals.js";
import {
  CLASSIFY_SYSTEM_PROMPT,
  MAX_BATCH_SIZE,
  buildBatchUserPrompt,
  parseBatchResponse,
  sanitize,
} from "./classify.js";
import type { AIProvider } from "./types.js";

/** Suggested small, fast models surfaced in options/docs (Q8-class). */
export const SUGGESTED_MODELS: readonly string[] = Object.freeze([
  "qwen3:0.6b",
  "qwen2.5:0.5b",
  "smollm2:360m",
  "llama3.2:1b",
]);

export interface OllamaConfig {
  /** Base URL of the OpenAI-compatible server. Default localhost:11434. */
  baseUrl?: string;
  /** Model tag, e.g. "qwen3:0.6b". Required for useful results. */
  model: string;
  /** Hard timeout in ms for the whole batch call. Default 30_000. */
  timeoutMs?: number;
  /** Injectable fetch (tests / service-worker binding). Defaults to global. */
  fetchFn?: typeof fetch;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BASE_URL = "http://localhost:11434";

function err(context: string, detail: string): Error {
  return new Error(`[nobait:ollama] ${context}: ${detail}`);
}

/**
 * SSRF guard: validate a user-configured base URL before any request is
 * made against it.
 *
 * Rules:
 * - must parse as an absolute URL
 * - scheme must be http or https (blocks file:, chrome:, etc.)
 * - no embedded credentials (user:pass@host)
 *
 * @returns the normalized origin (scheme + host + port), or an Error with
 * a descriptive message when the URL must be rejected.
 */
export function validateBaseUrl(
  raw: string,
  context = "constructor",
): { origin: string } | { error: Error } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: err(context, `invalid URL: ${JSON.stringify(raw)}`) };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      error: err(
        context,
        `scheme must be http or https, got ${parsed.protocol}//`,
      ),
    };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      error: err(context, "credentials in URL are not allowed"),
    };
  }
  return { origin: parsed.origin };
}

/**
 * Local Ollama provider. Streaming note: we intentionally consume the
 * non-streaming chat-completions call and yield results per video after
 * parse — most local servers buffer SSE anyway, and one round trip for a
 * ≤ 20-video batch stays well inside the 2 s budget with small models.
 */
export class OllamaProvider implements AIProvider {
  readonly name: string;
  readonly supportsStreaming = false;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly controller: AbortController = new AbortController();

  constructor(config: OllamaConfig) {
    if (!config.model || config.model.trim().length === 0) {
      throw err("constructor", "model is required (e.g. 'qwen3:0.6b')");
    }
    this.model = config.model;
    this.name = `ollama:${config.model}`;
    // SSRF guard: reject non-http(s) schemes and credential-bearing URLs
    // before anything is ever fetched. Path/query/hash are dropped so the
    // provider only ever talks to the bare origin.
    const rawUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const validated = validateBaseUrl(rawUrl);
    if ("error" in validated) throw validated.error;
    this.baseUrl = validated.origin;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = config.fetchFn ?? fetch;
    if (this.timeoutMs <= 0) {
      throw err(
        "constructor",
        `timeoutMs must be positive, got ${this.timeoutMs}`,
      );
    }
  }

  async *analyzeBatch(input: BatchInput): AsyncIterable<AnalysisResult> {
    if (input.length === 0) return;

    // Defensive copy: never trust (or mutate) caller-owned data.
    const batch: readonly VideoSignal[] = [...input];

    for (const chunk of chunkBatch(batch, MAX_BATCH_SIZE)) {
      const results = await this.analyzeChunk(chunk);
      for (const result of results) yield result;
    }
  }

  private async analyzeChunk(
    chunk: readonly VideoSignal[],
  ): Promise<AnalysisResult[]> {
    const messages: ChatMessage[] = [
      { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
      { role: "user", content: buildBatchUserPrompt(chunk) },
    ];

    const timeout = setTimeout(() => this.controller.abort(), this.timeoutMs);

    let raw: string;
    try {
      const response = await this.fetchFn(
        `${this.baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages,
            // Low temperature: deterministic tier picks, no creativity wanted.
            temperature: 0.1,
            stream: false,
          }),
          signal: this.controller.signal,
        },
      );

      if (!response.ok) {
        // Non-JSON error pages are common (server down → HTML 502).
        const bodyText = await response.text().catch(() => "");
        throw err(
          "request failed",
          `HTTP ${response.status} ${response.statusText}${bodyText ? ` — ${sanitize(bodyText, 200)}` : ""}`,
        );
      }

      const json = (await response.json()) as ChatCompletionResponse;
      raw = json.choices?.[0]?.message?.content ?? "";
      if (raw.length === 0) {
        throw err("empty response", "model returned no content");
      }
    } catch (cause) {
      // AbortController fires while pending chunks still stream out — map
      // every transport-level failure to a descriptive Error.
      if (cause instanceof Error && cause.name === "AbortError") {
        throw err("timeout", `exceeded ${this.timeoutMs}ms hard timeout`);
      }
      if (cause instanceof TypeError) {
        throw err(
          "network error",
          `cannot reach ${this.baseUrl}. If using a local Ollama server, ensure it is running and that the extension has been granted permission to access http://localhost.`,
        );
      }
      throw cause instanceof Error
        ? err("request failed", cause.message)
        : err("request failed", String(cause));
    } finally {
      clearTimeout(timeout);
    }

    // Strict parse: malformed model output degrades to UNSURE, never throws.
    return parseBatchResponse(raw, chunk);
  }

  /** Abort any in-flight request ( AbortController is shared per instance ). */
  close(): void {
    this.controller.abort();
  }
}

function* chunkBatch<T>(
  items: readonly T[],
  size: number,
): Generator<readonly T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

/**
 * Convenience factory: probe-friendly way to test an endpoint before the
 * factory commits to it. Sends a 1-token ping; resolves true iff reachable.
 */
export async function probeEndpoint(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<boolean> {
  const validated = validateBaseUrl(baseUrl, "probeEndpoint");
  if ("error" in validated) throw validated.error;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${validated.origin}/v1/models`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Re-export so consumers of this module can tier-check results without a
// second import site.
export { StampTier };
