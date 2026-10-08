/**
 * Factory tests — selection order per AGENTS.md:
 *   1. Chrome built-in AI if available
 *   2. Gemini if key set
 *   3. Ollama if URL configured
 *   4. Disabled with console warning
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createProvider, isChromeBuiltinAvailable } from "../../ai/factory.js";
import { NanoProvider } from "../../ai/nano.js";
import { OllamaProvider } from "../../ai/ollama.js";
import type { AIProvider } from "../../ai/types.js";

describe("isChromeBuiltinAvailable()", () => {
  test("false when window.LanguageModel absent (Firefox-like)", () => {
    vi.stubGlobal("LanguageModel", undefined);
    expect(isChromeBuiltinAvailable()).toBe(false);
    vi.unstubAllGlobals();
  });

  test("true when window.LanguageModel present", () => {
    vi.stubGlobal("LanguageModel", {});
    expect(isChromeBuiltinAvailable()).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("createProvider() selection order", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function withWindow(win: Record<string, unknown>) {
    // The provider/factory probe `globalThis.LanguageModel` (service-worker
    // safe), so stub that directly — `win` is retained for readability.
    for (const [k, v] of Object.entries(win)) {
      vi.stubGlobal(k, v);
    }
  }

  test("1) Chrome built-in wins even when Gemini + Ollama configured", () => {
    withWindow({ LanguageModel: {} });
    const fakeGemini = vi.fn(
      (): AIProvider => ({ name: "gemini", supportsStreaming: true, analyzeBatch: async function* () {} }),
    );

    const sel = createProvider({
      geminiApiKey: "AIza-fake",
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen3:0.6b",
      createGeminiProvider: fakeGemini,
    });

    expect(sel.provider).toBeInstanceOf(NanoProvider);
    expect(fakeGemini).not.toHaveBeenCalled();
    expect(sel.reason).toMatch(/chrome-builtin/i);
  });

  test("2) Gemini when key set and Chrome AI unavailable", () => {
    withWindow({});
    const fakeGemini = vi.fn(
      (key: string): AIProvider => ({
        name: `gemini:${key.slice(0, 4)}`,
        supportsStreaming: true,
        analyzeBatch: async function* () {},
      }),
    );

    const sel = createProvider({
      geminiApiKey: "AIza-fake",
      createGeminiProvider: fakeGemini,
    });

    expect(fakeGemini).toHaveBeenCalledWith("AIza-fake", undefined);
    expect(sel.provider!.name).toBe("gemini:AIza");
  });

  test("3) Ollama when only local URL + model configured", () => {
    withWindow({});
    const sel = createProvider({
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen3:0.6b",
    });

    expect(sel.provider).toBeInstanceOf(OllamaProvider);
    expect(sel.reason).toMatch(/local endpoint/i);
  });

  test("2→3) falls through to Ollama when Gemini loader missing", () => {
    withWindow({});
    const sel = createProvider({
      geminiApiKey: "key",
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen3:0.6b",
      // no createGeminiProvider
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/Gemini key set but no Gemini provider loader/),
    );
    expect(sel.provider).toBeInstanceOf(OllamaProvider);
  });

  test("2→3) falls through when Gemini construction throws", () => {
    withWindow({});
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const sel = createProvider({
      geminiApiKey: "key",
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "m",
      createGeminiProvider: throwing,
    });

    expect(throwing).toHaveBeenCalled();
    expect(sel.provider).toBeInstanceOf(OllamaProvider);
  });

  test("4) disabled with console warning when nothing configured", () => {
    withWindow({});
    const sel = createProvider({});

    expect(sel.provider).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/No AI provider available/),
    );
  });

  test("Ollama requires both URL and model — URL alone → disabled", () => {
    withWindow({});
    const sel = createProvider({ ollamaBaseUrl: "http://localhost:11434" });
    expect(sel.provider).toBeNull();
  });

  test("blank Gemini key treated as unset → falls to Ollama", () => {
    withWindow({});
    const sel = createProvider({
      geminiApiKey: "   ",
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen3:0.6b",
    });
    expect(sel.provider).toBeInstanceOf(OllamaProvider);
  });

  test("passes timeoutMs through to Ollama", () => {
    withWindow({});
    const sel = createProvider({
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "m",
      timeoutMs: 5000,
    });
    // Reaching into the private field for verification only.
    const internal = (sel.provider as unknown as { timeoutMs: number }).timeoutMs;
    expect(internal).toBe(5000);
  });
});
