/**
 * Tests for the AIProviderFactory singleton's initialize() config handling,
 * particularly the `preferredProvider` pinning that wires the options-page
 * backend dropdown to the actual provider selection (M5).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { AIProviderFactory } from "../../ai/factory.js";
import { OllamaProvider } from "../../ai/ollama.js";
import { GeminiProvider } from "../../ai/gemini.js";

describe("AIProviderFactory.initialize() preferredProvider wiring", () => {
  beforeEach(() => {
    vi.stubGlobal("LanguageModel", undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function freshFactory(): AIProviderFactory {
    // Private constructor — reach through getInstance's static and reset it.
    const f = Object.create(AIProviderFactory.prototype) as AIProviderFactory;
    return f;
  }

  test("preferredProvider=ollama pins selection to Ollama even with Gemini key", async () => {
    const f = freshFactory();
    const p = await f.initialize({
      preferredProvider: "ollama",
      geminiApiKey: "AIza-fake",
      ollamaUrl: "http://localhost:11434",
      ollamaModel: "qwen3:0.6b",
    });
    expect(p).toBeInstanceOf(OllamaProvider);
  });

  test("preferredProvider=gemini ignores Ollama config", async () => {
    const f = freshFactory();
    const p = await f.initialize({
      preferredProvider: "gemini",
      geminiApiKey: "AIza-fake",
      ollamaUrl: "http://localhost:11434",
      ollamaModel: "qwen3:0.6b",
    });
    expect(p).toBeInstanceOf(GeminiProvider);
    expect(p).not.toBeInstanceOf(OllamaProvider);
  });

  test("auto/undefined follows the full chain (Gemini when key set)", async () => {
    const f = freshFactory();
    const p = await f.initialize({
      geminiApiKey: "AIza-fake",
      ollamaUrl: "http://localhost:11434",
      ollamaModel: "qwen3:0.6b",
    });
    expect(p).toBeInstanceOf(GeminiProvider);
  });

  test("same config returns cached provider; changed config rebuilds", async () => {
    const f = freshFactory();
    const first = await f.initialize({
      ollamaUrl: "http://localhost:11434",
      ollamaModel: "m1",
    });
    const again = await f.initialize({
      ollamaUrl: "http://localhost:11434",
      ollamaModel: "m1",
    });
    expect(again).toBe(first);

    const changed = await f.initialize({
      ollamaUrl: "http://localhost:11434",
      ollamaModel: "m2",
    });
    expect(changed).not.toBe(first);
  });

  test("preferredProvider=ollama without endpoint falls back to Gemini with warning", async () => {
    const f = freshFactory();
    const p = await f.initialize({
      preferredProvider: "ollama",
      geminiApiKey: "AIza-fake",
    });
    expect(p).toBeInstanceOf(GeminiProvider);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Ollama preferred/),
    );
  });
});
