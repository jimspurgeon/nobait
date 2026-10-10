/**
 * Built-in on-device AI provider (wllama: llama.cpp compiled to WASM).
 *
 * Zero-config last resort in the provider chain (AGENTS.md priority 4):
 * when neither Chrome built-in AI, a Gemini key, nor a local Ollama
 * endpoint is configured, the extension downloads a small GGUF model from
 * HuggingFace on first use and runs inference fully on-device. Nothing
 * leaves the machine; the model is cached in OPFS across sessions.
 *
 * Why wllama: single-file ESM, llama.cpp WASM backend, OPFS-backed
 * CacheManager, works in a Firefox MV3 event-page (JSPI + memory64 present
 * in Firefox ≥ 133; older browsers degrade via the runtime gate below).
 *
 * Static worker strategy: the build vendors @wllama/wllama with
 * `createWorker` patched to spawn packaged static workers (`ai-worker.js`,
 * `opfs-worker.js`) instead of blob: URLs, which Firefox MV3 CSP forbids.
 */

import type { AnalysisResult, AIProvider, BatchInput } from "./types.js";
import {
  CLASSIFY_SYSTEM_PROMPT,
  buildBatchUserPrompt,
  parseBatchResponse,
} from "./classify.js";
import type { VideoSignal } from "../content/signals.js";
import { StampTier } from "../stamps/types.js";

/**
 * Shape of the vendored Wllama class we rely on. Structural so tests can
 * stub the loader without the real ~400KB module.
 */
export interface WllamaLike {
  loadModelFromUrl(
    urls: string[],
    config: Record<string, unknown>,
  ): Promise<void>;
  createChatCompletion(
    messages: Array<{ role: string; content: string }>,
    options?: Record<string, unknown>,
  ): Promise<string>;
  exit(): Promise<void>;
}

/** Injectable loader — production wires the vendored wllama module. */
export type WllamaLoader = () => Promise<WllamaLike>;

export interface WasmProviderConfig {
  /** GGUF model URL(s); defaults to the built-in catalogue below. */
  modelUrls?: string[];
  /** Chat template override; rarely needed. */
  chatTemplate?: string;
  /** Hard cap on generated tokens per completion. */
  maxTokens?: number;
  /** Overrides for tests. */
  loader?: WllamaLoader;
  /** Runtime-support gate override for tests. */
  runtimeSupported?: boolean;
  /** Progress sink for the model download (broadcast to options page). */
  onDownloadProgress?: (info: {
    loaded: number;
    total: number;
  }) => void;
}

/**
 * Built-in model catalogue. Sizes are approximate download sizes.
 * Keep in sync with the options-page model picker.
 */
export const BUILTIN_MODELS = {
  "qwen2.5-0.5b": {
    label: "Qwen2.5 0.5B Instruct (recommended, ~470 MB)",
    urls: [
      "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    ],
  },
  "smollm2-360m": {
    label: "SmolLM2 360M Instruct (smaller, ~370 MB)",
    urls: [
      "https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF/resolve/main/smollm2-360m-instruct-q8_0.gguf",
    ],
  },
  "stories15m": {
    label: "TinyLlama stories 15M (test-only, ~19 MB)",
    urls: [
      "https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories15M-q4_0.gguf",
    ],
  },
} as const;

export type BuiltinModelId = keyof typeof BUILTIN_MODELS;

/** Videos per completion request — small models drift on long batches. */
export const WASM_BATCH_CHUNK = 3;

/**
 * Runtime support gate: wllama needs WebAssembly JSPI + memory64.
 * Firefox ships both since 133; strict_min_version 115 users just don't
 * get this provider (graceful degradation per AGENTS.md).
 */
export function isWasmRuntimeSupported(): boolean {
  try {
    if (typeof WebAssembly === "undefined") return false;
    if (typeof (WebAssembly as unknown as Record<string, unknown>).Suspending !== "function") {
      return false;
    }
    new WebAssembly.Memory({
      initial: 1,
      index: "i64",
    } as WebAssembly.MemoryDescriptor);
    return true;
  } catch {
    return false;
  }
}

/**
 * Construct a Wllama instance through the injectable loader.
 * Kept separate from the class for easy test stubbing. The vendored
 * module (build patch) wires the packaged static workers.
 */
async function defaultLoader(): Promise<WllamaLike> {
  const mod = (await import("@wllama/wllama")) as unknown as {
    Wllama: new (cfg: Record<string, unknown>) => WllamaLike;
  };
  return new mod.Wllama({});
}

export class WasmProvider implements AIProvider {
  readonly name = "builtin-wasm";
  readonly supportsStreaming = false;

  private readonly modelUrls: string[];
  private readonly maxTokens: number;
  private readonly loader: WllamaLoader;
  private readonly runtimeGate: () => boolean;
  private readonly onProgress?: (info: { loaded: number; total: number }) => void;

  private instance: WllamaLike | null = null;
  private loading: Promise<WllamaLike> | null = null;

  constructor(config: WasmProviderConfig = {}) {
    this.modelUrls = [...(config.modelUrls ?? BUILTIN_MODELS["qwen2.5-0.5b"].urls)];
    this.maxTokens = config.maxTokens ?? 512;
    this.loader = config.loader ?? defaultLoader;
    this.runtimeGate = config.runtimeSupported !== undefined
      ? () => config.runtimeSupported === true
      : isWasmRuntimeSupported;
    this.onProgress = config.onDownloadProgress;
  }

  /** True when this browser can run the WASM backend at all. */
  get supported(): boolean {
    return this.runtimeGate();
  }

  /**
   * Lazily load the model on first analyze — NOT at construction, so a
   * Firefox 115 user who never picks "builtin" never downloads anything.
   */
  private async ensureModel(): Promise<WllamaLike> {
    if (this.instance !== null) return this.instance;
    if (this.loading !== null) return this.loading;

    if (!this.supported) {
      throw new Error(
        "builtin WASM AI unavailable: this browser lacks WebAssembly JSPI/memory64 (needs Firefox ≥ 133)",
      );
    }

    this.loading = (async () => {
      const wllama = await this.loader();
      try {
        await wllama.loadModelFromUrl(this.modelUrls, {
          n_ctx: 4096,
          n_threads: 1,
          parallelDownloads: 1,
          ...(this.onProgress ? { progressCallback: this.onProgress } : {}),
        });
        this.instance = wllama;
        return wllama;
      } catch (cause) {
        this.loading = null;
        throw new Error(
          `builtin WASM AI failed to load model from ${this.modelUrls[0]}: ${(cause as Error)?.message ?? cause}`,
        );
      }
    })();
    return this.loading;
  }

  async *analyzeBatch(input: BatchInput): AsyncIterable<AnalysisResult> {
    const chunks: VideoSignal[][] = [];
    for (let i = 0; i < input.length; i += WASM_BATCH_CHUNK) {
      chunks.push([...input.slice(i, i + WASM_BATCH_CHUNK)]);
    }

    const wllama = await this.ensureModel();

    for (const chunk of chunks) {
      try {
        const systemMsg = { role: "system" as const, content: CLASSIFY_SYSTEM_PROMPT };
        const userMsg = { role: "user" as const, content: buildBatchUserPrompt(chunk) };
        const completion = await wllama.createChatCompletion([systemMsg, userMsg], {
          max_tokens: this.maxTokens,
          temperature: 0.3,
        });
        yield* parseBatchResponse(completion, chunk);
      } catch (err) {
        console.error("[nobait:wasm] chunk analysis failed:", err);
        for (const video of chunk) {
          yield {
            videoId: video.videoId,
            rewrittenTitle: video.title,
            stamp: StampTier.UNSURE,
            stampExplanation: "WASM provider error — showing original content",
          };
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.instance !== null) {
      try {
        await this.instance.exit();
      } catch (e) {
        console.warn("[nobait:wasm] exit() failed:", e);
      } finally {
        this.instance = null;
      }
    }
  }
}
