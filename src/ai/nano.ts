/**
 * Chrome built-in AI (Gemini Nano / Prompt API) provider (AGENTS.md `ai/nano.ts`,
 * PLAN.md §4 priority-1 on-device backend).
 *
 * Uses the NEW `window.LanguageModel` API (Chrome 138+, PLAN.md §4 notes).
 * Feature-detects availability; returns a provider that reports "unavailable"
 * on Firefox and other non-Chromium environments so the factory can fall
 * through cleanly to Ollama/Gemini.
 */

import { StampTier } from "../stamps/types.js";
import type { AnalysisResult, BatchInput } from "./types.js";
import type { VideoSignal } from "../content/signals.js";
import {
  CLASSIFY_SYSTEM_PROMPT,
  MAX_BATCH_SIZE,
  buildBatchUserPrompt,
  parseBatchResponse,
} from "./classify.js";
import type { AIProvider } from "./types.js";

/**
 * Availability states exposed by the Prompt API (Chrome 138+).
 * The exact union comes from the spec; we mirror it here for type safety.
 */
type LangModelAvailability =
  | "unavailable" // model cannot be downloaded on this device
  | "after-download" // available after download completes
  | "readily"; // available now

interface LanguageModelSessionOptions {
  expectedInputs?: Array<{ type: "text"; languages?: string[] }>;
  expectedOutputs?: Array<{ type: "text"; languages?: string[] }>;
  initialPrompts?: Array<{ role: "system"; content: string }>;
  monitor?: {
    addEventListener: (event: string, listener: (e: unknown) => void) => void;
  };
}

interface LanguageModelCreateOptions extends LanguageModelSessionOptions {
  temperature?: number;
  topK?: number;
}

export interface LanguageModel {
  /** Check readiness without downloading. */
  availability(options?: LanguageModelSessionOptions): Promise<LangModelAvailability>;
  /** Create a chat session. */
  create(options: LanguageModelCreateOptions): Promise<LanguageModelSession>;
  /** Query params for the current device/model. */
  params(): Promise<{
    defaultTopK: number;
    maxTopK: number;
    defaultTemperature: number;
    maxTemperature: number;
  }>;
}

interface LanguageModelSession {
  /** One-shot prompt (non-streaming) — simplest for our use case. */
  prompt(input: string): Promise<string>;
  /** Streaming variant (async iterable) — not required here. */
  promptStreaming?(input: string): AsyncIterable<string>;
  destroy(): void;
}

export interface NanoConfig {
  /** Optional timeout per prompt (ms). Default 10_000. */
  timeoutMs?: number;
  /** Temperature override (default 0.2 for determinism). */
  temperature?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TEMPERATURE = 0.2;

function err(context: string, detail: string): Error {
  return new Error(`[nobait:nano] ${context}: ${detail}`);
}

/**
 * Runtime handle for the Chromium Prompt API.
 *
 * Checked via `globalThis` rather than `window` deliberately: the API exists
 * in window contexts AND extension service workers (where `window` is
 * undefined), and this single probe covers both. On Firefox (or Chrome
 * without the API) it returns `undefined`, which the factory treats as
 * "fall through to the next backend".
 */
export function getLanguageModel(): LanguageModel | undefined {
  const g = globalThis as { LanguageModel?: LanguageModel };
  return g.LanguageModel;
}

/**
 * Chrome built-in AI provider.
 *
 * On Firefox or older Chrome this returns a stub that always yields
 * {@link StampTier.UNSURE} and logs a friendly "unavailable" warning so
 * the factory can seamlessly fall back to Ollama/Gemini without breaking
 * the pipeline.
 */
export class NanoProvider implements AIProvider {
  readonly name: string;
  readonly supportsStreaming = false;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private fallbackOnly: boolean;
  private session: LanguageModelSession | null = null;

  constructor(config?: NanoConfig) {
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.temperature = config?.temperature ?? DEFAULT_TEMPERATURE;

    // Feature detection: is the Chromium Prompt API present in this runtime?
    this.fallbackOnly = getLanguageModel() === undefined;
    this.name = this.fallbackOnly ? "chrome:nano(unavailable)" : "chrome:nano";
  }

  async *analyzeBatch(input: BatchInput): AsyncIterable<AnalysisResult> {
    if (this.fallbackOnly) {
      // Signal to callers that we are truly unavailable (factory uses this
      // to decide whether to skip us entirely).
      for (const video of input) {
        yield {
          videoId: video.videoId,
          rewrittenTitle: video.title, // graceful degradation
          stamp: StampTier.UNSURE,
          stampExplanation:
            "Chrome built-in AI (Nano) is unavailable on this browser.",
        };
      }
      return;
    }

    // Lazy-init the session on first batch. Failure here (model can't be
    // downloaded, runtime lost the API) degrades to UNSURE for the whole
    // batch rather than throwing — the factory already did its static check,
    // so this is an unexpected-but-recoverable state.
    if (!this.session) {
      try {
        await this.initSession();
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        for (const video of input) {
          yield {
            videoId: video.videoId,
            rewrittenTitle: video.title,
            stamp: StampTier.UNSURE,
            stampExplanation: `Chrome built-in AI unavailable: ${detail}`,
          };
        }
        return;
      }
    }

    for (const chunk of chunkBatch(input, MAX_BATCH_SIZE)) {
      const results = await this.analyzeChunk(chunk);
      for (const result of results) yield result;
    }
  }

  private async initSession(): Promise<void> {
    const LM = getLanguageModel();
    if (LM === undefined) {
      // Runtime lost the API between construction and first use.
      this.fallbackOnly = true;
      throw err("unavailable", "Prompt API disappeared from this runtime");
    }
    try {
      const availability = await LM.availability({
        expectedInputs: [{ type: "text" }],
        expectedOutputs: [{ type: "text" }],
      });

      if (availability === "unavailable") {
        this.fallbackOnly = true;
        throw err(
          "unavailable",
          "model cannot be downloaded on this device (Nano not supported)",
        );
      }

      // Create with conservative parameters; tiny models thrive on low temp.
      this.session = await LM.create({
        temperature: this.temperature,
        initialPrompts: [{ role: "system", content: CLASSIFY_SYSTEM_PROMPT }],
      });
    } catch (cause) {
      this.fallbackOnly = true;
      this.session = null;
      if (cause instanceof Error) throw err("init failed", cause.message);
      throw err("init failed", String(cause));
    }
  }

  private async analyzeChunk(chunk: readonly VideoSignal[]): Promise<AnalysisResult[]> {
    if (!this.session || this.fallbackOnly) {
      // Should not happen if initSession() was called successfully, but guard
      // defensively so a mid-stream crash doesn't take down the whole extension.
      return chunk.map((v) => ({
        videoId: v.videoId,
        rewrittenTitle: v.title,
        stamp: StampTier.UNSURE,
        stampExplanation: "Nano session became unavailable mid-batch.",
      }));
    }

    const userPrompt = buildBatchUserPrompt(chunk);

    // Race the prompt against a hard timeout: on expiry the session is
    // destroyed AND the pending promise rejects, so a hung model can never
    // wedge the batch pipeline.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    void timedOut; // written by the timeout race; retained for clarity
    const timeoutRace = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.session?.destroy();
        const e = new Error(`prompt exceeded ${this.timeoutMs}ms hard timeout`);
        e.name = "AbortError";
        reject(e);
      }, this.timeoutMs);
    });

    try {
      const raw = await Promise.race([this.session.prompt(userPrompt), timeoutRace]);
      return parseBatchResponse(raw, chunk);
    } catch (cause) {
      // Session corruption → mark as unavailable for subsequent batches.
      this.fallbackOnly = true;
      this.session = null;
      const msg = cause instanceof Error ? cause.message : String(cause);
      return chunk.map((v) => ({
        videoId: v.videoId,
        rewrittenTitle: v.title,
        stamp: StampTier.UNSURE,
        stampExplanation: `Nano error: ${msg}`,
      }));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Cleanup on shutdown (session may be long-lived; destroy explicitly). */
  close(): void {
    if (this.session) {
      this.session.destroy();
      this.session = null;
    }
  }
}

/** Utility generator: split a batch into chunks of fixed size. */
function* chunkBatch<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
