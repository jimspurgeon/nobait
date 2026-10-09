/**
 * Unit tests for zero-config Ollama autodetection.
 */

import { describe, it, expect } from "vitest";
import { detectOllama } from "../../ai/autodetect";

/** Build a stub fetch answering /api/tags with a canned catalog. */
function tagsFetch(models: Array<{ name: string; size?: number }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const refusedFetch = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

describe("detectOllama", () => {
  it("returns null when nothing is listening", async () => {
    expect(await detectOllama(refusedFetch as typeof fetch)).toBeNull();
  });

  it("returns null for an empty model catalog", async () => {
    expect(await detectOllama(tagsFetch([]))).toBeNull();
  });

  it("picks a suggested model over larger generic ones", async () => {
    const hit = await detectOllama(
      tagsFetch([
        { name: "llama3.1:70b", size: 40_000_000_000 },
        { name: "qwen3:0.6b", size: 500_000_000 },
      ]),
    );
    expect(hit).toEqual({ url: "http://localhost:11434", model: "qwen3:0.6b" });
  });

  it("falls back to a generic chat model when no suggested one exists", async () => {
    const hit = await detectOllama(
      tagsFetch([
        { name: "nomic-embed-text", size: 100 },
        { name: "mistral:7b", size: 4_000_000_000 },
      ]),
    );
    expect(hit?.model).toBe("mistral:7b");
  });

  it("deprioritizes embedding models even when smallest", async () => {
    const hit = await detectOllama(
      tagsFetch([
        { name: "nomic-embed-text", size: 100 },
        { name: "unknown-model", size: 1_000 },
      ]),
    );
    expect(hit?.model).toBe("unknown-model");
  });

  it("tries 127.0.0.1 after localhost fails", async () => {
    let calls = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls++;
      const url = String(input);
      if (url.startsWith("http://127.0.0.1")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen3:0.6b" }] }),
          { status: 200 },
        );
      }
      throw new TypeError("refused");
    }) as typeof fetch;
    const hit = await detectOllama(fetchFn);
    expect(calls).toBe(2);
    expect(hit).toEqual({ url: "http://127.0.0.1:11434", model: "qwen3:0.6b" });
  });
});
