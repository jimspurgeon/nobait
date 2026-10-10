/**
 * Provider selection + fallback chain (AGENTS.md `ai/factory.ts`, selection
 * order; PLAN.md §4 speed-ordered backends).
 *
 * Order per AGENTS.md "AI provider implementation guide":
 *   1. Chrome built-in AI if available
 *   2. Gemini if an API key is set
 *   3. Ollama if a local URL is configured
 *   4. Built-in on-device WASM (wllama) if the runtime supports it
 *   5. Otherwise → disabled (console warning, null returned)
 *
 * To avoid a hard dependency on the Gemini module (built by a parallel
 * worker, P3), this factory accepts the Gemini provider via a lazy loader
 * callback. If the loader is absent or throws, the chain skips Gemini
 * gracefully.
 */

import { NanoProvider } from "./nano.js";
import { OllamaProvider } from "./ollama.js";
import { WasmProvider, isWasmRuntimeSupported } from "./wasm.js";
import type { AIProvider } from "./types.js";

/** Config the options page feeds into the factory. */
export interface AIProviderConfig {
  /** Gemini API key, if the user set one (priority 2). */
  geminiApiKey?: string;
  /** Base URL of the local OpenAI-compatible endpoint (priority 3). */
  ollamaBaseUrl?: string;
  /** Local model tag, e.g. "qwen3:0.6b" (required with ollamaBaseUrl). */
  ollamaModel?: string;
  /** Hard timeout (ms) for local/network provider calls. */
  timeoutMs?: number;
  /**
   * Optional lazy Gemini-module loader injected by the background entry
   * point (avoids coupling this module to a parallel-workstream file).
   */
  createGeminiProvider?: (apiKey: string, timeoutMs?: number) => AIProvider;
  /**
   * Optional lazy WASM-provider loader (same injection pattern). When
   * absent the chain skips the built-in backend gracefully.
   */
  createWasmProvider?: () => AIProvider;
  /** Suppress the Chrome builtin step (used when the user pinned builtin). */
  skipChromeBuiltin?: boolean;
}

/** Which provider the factory selected — used by the options UI badge. */
export interface ProviderSelection {
  provider: AIProvider | null;
  /** Why this provider was picked (or why none was). */
  reason: string;
}

/**
 * Static availability check used by the factory's step 1: is the Chromium
 * Prompt API present in this runtime? Cheap, synchronous, no model download.
 * Checks `globalThis` to cover both window contexts and service workers.
 */
export function isChromeBuiltinAvailable(): boolean {
  const LM: unknown = (globalThis as { LanguageModel?: unknown }).LanguageModel;
  return LM !== undefined;
}

/**
 * Select and construct the best available provider per the priority chain.
 * Returns `{ provider: null, reason }` when everything is unavailable so
 * callers can disable title rewriting with a console warning.
 */
export function createProvider(config: AIProviderConfig): ProviderSelection {
  // -- 1. Chrome built-in AI ------------------------------------------------
  // NanoProvider self-detects; if the API is missing (Firefox), it operates
  // as a stub that reports UNSURE, which we treat as "not selectable" here.
  if (!config.skipChromeBuiltin && isChromeBuiltinAvailable()) {
    return {
      provider: new NanoProvider({ timeoutMs: config.timeoutMs }),
      reason: "chrome-builtin AI (Gemini Nano) detected",
    };
  }

  // -- 2. Gemini (BYO key) --------------------------------------------------
  if (
    config.geminiApiKey !== undefined &&
    config.geminiApiKey.trim().length > 0
  ) {
    if (config.createGeminiProvider === undefined) {
      console.warn(
        "[nobait] Gemini key set but no Gemini provider loader registered — skipping",
      );
    } else {
      try {
        return {
          provider: config.createGeminiProvider(
            config.geminiApiKey.trim(),
            config.timeoutMs,
          ),
          reason: "Gemini API key configured",
        };
      } catch (cause) {
        console.warn(
          "[nobait] Gemini provider construction failed, falling through to Ollama",
          cause,
        );
      }
    }
  }

  // -- 3. Ollama / local endpoint ---------------------------------------------
  if (
    config.ollamaBaseUrl !== undefined &&
    config.ollamaBaseUrl.trim().length > 0 &&
    config.ollamaModel !== undefined &&
    config.ollamaModel.trim().length > 0
  ) {
    return {
      provider: new OllamaProvider({
        baseUrl: config.ollamaBaseUrl.trim(),
        model: config.ollamaModel.trim(),
        timeoutMs: config.timeoutMs,
      }),
      reason: `local endpoint configured (${config.ollamaModel.trim()})`,
    };
  }

  // -- 4. Built-in on-device WASM (zero-config last resort) -------------------
  if (config.createWasmProvider !== undefined) {
    try {
      return {
        provider: config.createWasmProvider(),
        reason: "built-in on-device AI (wllama)",
      };
    } catch (cause) {
      console.warn(
        "[nobait] WASM provider construction failed, falling through",
        cause,
      );
    }
  }

  // -- 5. Disabled -----------------------------------------------------------
  console.warn(
    "[nobait] No AI provider available — title rewriting disabled. " +
      "Configure Chrome built-in AI, a Gemini key, or a local Ollama URL in options.",
  );
  return {
    provider: null,
    reason: "no provider available",
  };
}

// ---------------------------------------------------------------------------
// P3-compatible singleton facade (background/scheduler + options wiring)
// ---------------------------------------------------------------------------

import { GeminiProvider } from "./gemini.js";

/**
 * Legacy-compatible factory singleton. Wraps {@link createProvider} with the
 * P3 `initialize()` semantics so the background scheduler can keep its
 * provider lifecycle unchanged. Lazily constructs the underlying provider
 * using stored config; re-initializes when the configuration changes.
 */
export class AIProviderFactory {
  private static instance: AIProviderFactory;
  private provider: AIProvider | null = null;
  private currentProviderName: string | null = null;
  private configKey: string | null = null;
  /** Last fully-applied config (preserves autodetected Ollama across calls). */
  private lastAppliedConfig: {
    preferredProvider?: "gemini" | "ollama" | "chrome" | "builtin";
    geminiApiKey?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
    useChromeAI?: boolean;
  } | null = null;

  private constructor() {}

  static getInstance(): AIProviderFactory {
    if (!AIProviderFactory.instance) {
      AIProviderFactory.instance = new AIProviderFactory();
    }
    return AIProviderFactory.instance;
  }

  /**
   * Initialize (or reuse) a provider based on configuration.
   *
   * `preferredProvider` honors the options-page dropdown: it pins the
   * chain to the chosen backend by suppressing the others' credentials
   * ("gemini" ignores the Ollama URL, "ollama" ignores the Gemini key).
   * `undefined`/"auto" follows the full chain. `ollamaModel` supplies the
   * model tag required for the local endpoint. "builtin" pins the
   * zero-config on-device WASM backend.
   */
  async initialize(config: {
    preferredProvider?: "gemini" | "ollama" | "chrome" | "builtin";
    geminiApiKey?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
    useChromeAI?: boolean;
  }): Promise<AIProvider> {
    // An empty config (e.g. the scheduler's flush-time re-init) inherits
    // the last settings-driven config so an autodetected local Ollama
    // survives instead of being wiped back to "no provider".
    if (
      config.preferredProvider === undefined &&
      config.geminiApiKey === undefined &&
      config.ollamaUrl === undefined &&
      config.ollamaModel === undefined &&
      this.lastAppliedConfig !== null
    ) {
      config = { ...this.lastAppliedConfig };
    }
    const prefer = config.preferredProvider;
    const configKey = JSON.stringify([
      prefer ?? "auto",
      config.geminiApiKey ?? "",
      config.ollamaUrl ?? "",
      config.ollamaModel ?? "",
      config.useChromeAI !== false,
    ]);
    if (this.provider && this.configKey === configKey) {
      return this.provider;
    }

    this.reset();
    this.configKey = configKey;
    this.lastAppliedConfig = { ...config };

    const selection = createProvider({
      geminiApiKey: prefer === "ollama" || prefer === "builtin" ? undefined : config.geminiApiKey,
      ollamaBaseUrl: prefer === "gemini" || prefer === "builtin" ? undefined : config.ollamaUrl,
      ollamaModel: config.ollamaModel,
      createGeminiProvider: (apiKey) => new GeminiProvider(apiKey),
      // The WASM step is only offered when the runtime can actually run
      // it; unsupported browsers keep the legacy Gemini-storage fallback.
      createWasmProvider: isWasmRuntimeSupported()
        ? () => new WasmProvider({})
        : undefined,
      skipChromeBuiltin: prefer === "builtin",
    });

    if (selection.provider === null) {
      if (prefer === "ollama") {
        console.warn(
          "[nobait] Ollama preferred but no local endpoint configured — falling back to Gemini.",
        );
      }
      // Fall back to the Gemini provider (loads its key from storage).
      const gemini = new GeminiProvider(config.geminiApiKey);
      if (!config.geminiApiKey) {
        await gemini.loadApiKey();
      }
      this.provider = gemini;
      this.currentProviderName = "gemini";
    } else if (prefer === "builtin" && selection.provider instanceof WasmProvider) {
      this.provider = selection.provider;
      this.currentProviderName = "builtin";
    } else {
      this.provider = selection.provider;
      this.currentProviderName = prefer ?? selection.reason;
    }

    return this.provider;
  }

  /** Get the current provider, if any. */
  getProvider(): AIProvider | null {
    return this.provider;
  }

  /** Current provider name (for logging / options UI). */
  getCurrentProviderName(): string | null {
    return this.currentProviderName;
  }

  /** Reset — next initialize() rebuilds from scratch. */
  reset(): void {
    if (this.provider?.close) {
      this.provider.close();
    }
    this.provider = null;
    this.currentProviderName = null;
  }
}

/** Singleton used by the background scheduler. */
export const aiProviderFactory = AIProviderFactory.getInstance();
