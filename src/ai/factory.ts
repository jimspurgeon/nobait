/**
 * Provider selection + fallback chain (AGENTS.md `ai/factory.ts`, selection
 * order; PLAN.md §4 speed-ordered backends).
 *
 * Order per AGENTS.md "AI provider implementation guide":
 *   1. Chrome built-in AI if available
 *   2. Gemini if an API key is set
 *   3. Ollama if a local URL is configured
 *   4. Otherwise → disabled (console warning, null returned)
 *
 * To avoid a hard dependency on the Gemini module (built by a parallel
 * worker, P3), this factory accepts the Gemini provider via a lazy loader
 * callback. If the loader is absent or throws, the chain skips Gemini
 * gracefully.
 */

import { NanoProvider, type LanguageModel } from "./nano.js";
import { OllamaProvider } from "./ollama.js";
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
  if (isChromeBuiltinAvailable()) {
    return {
      provider: new NanoProvider({ timeoutMs: config.timeoutMs }),
      reason: "chrome-builtin AI (Gemini Nano) detected",
    };
  }

  // -- 2. Gemini (BYO key) --------------------------------------------------
  if (config.geminiApiKey !== undefined && config.geminiApiKey.trim().length > 0) {
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

  // -- 4. Disabled -----------------------------------------------------------
  console.warn(
    "[nobait] No AI provider available — title rewriting disabled. " +
      "Configure Chrome built-in AI, a Gemini key, or a local Ollama URL in options.",
  );
  return {
    provider: null,
    reason: "no provider available",
  };
}
