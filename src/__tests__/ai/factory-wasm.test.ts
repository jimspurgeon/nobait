/**
 * Factory chain tests for the built-in WASM backend (step 4) and the
 * "builtin" backend pinning.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createProvider } from "../../ai/factory.js";
import { OllamaProvider } from "../../ai/ollama.js";
import type { AIProvider } from "../../ai/types.js";

function fakeWasm(): AIProvider {
  return {
    name: "builtin-wasm",
    supportsStreaming: false,
    analyzeBatch: async function* () {},
  };
}

describe("createProvider() WASM step 4", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("LanguageModel", undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("4) WASM used when nothing else configured and loader present", () => {
    const sel = createProvider({ createWasmProvider: fakeWasm });
    expect(sel.provider!.name).toBe("builtin-wasm");
    expect(sel.reason).toMatch(/built-in on-device/i);
  });

  test("4 skipped when loader absent (legacy wiring keeps old behavior)", () => {
    const sel = createProvider({});
    expect(sel.provider).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/No AI provider available/),
    );
  });

  test("Ollama still wins over WASM (priority order)", () => {
    const sel = createProvider({
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen3:0.6b",
      createWasmProvider: fakeWasm,
    });
    expect(sel.provider).toBeInstanceOf(OllamaProvider);
  });

  test("WASM loader exception falls through to disabled", () => {
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const sel = createProvider({ createWasmProvider: throwing });
    expect(throwing).toHaveBeenCalled();
    expect(sel.provider).toBeNull();
  });

  test("skipChromeBuiltin suppresses step 1", () => {
    vi.stubGlobal("LanguageModel", {});
    const sel = createProvider({
      skipChromeBuiltin: true,
      createWasmProvider: fakeWasm,
    });
    expect(sel.provider!.name).toBe("builtin-wasm");
  });
});
