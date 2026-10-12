/**
 * Ollama provider tests — fully mocked fetch (no real network).
 * Verifies: request shape, strict parsing, UNSURE fallback, timeout,
 * network-error mapping, non-mutation of input, close() aborts.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { StampTier } from "../../stamps/types.js";
import {
  OllamaProvider,
  SUGGESTED_MODELS,
  probeEndpoint,
  validateBaseUrl,
} from "../../ai/ollama.js";
import type { VideoSignal } from "../../content/signals.js";
import type { AnalysisResult } from "../../ai/types.js";

function mkBatch(n: number): VideoSignal[] {
  return Array.from({ length: n }, (_, i) => ({
    videoId: `vid_${i.toString().padStart(2, "0")}`,
    title: `Title ${i}`,
    description: `Description ${i}`,
  }));
}

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function validJsonFor(batch: VideoSignal[]): string {
  return JSON.stringify(
    batch.map((v, i) => ({
      id: v.videoId,
      title: `Rewritten ${i}`,
      tier: "legitimate",
      reason: `Reason ${i}`,
    })),
  );
}

async function collect(
  gen: AsyncIterable<AnalysisResult>,
): Promise<AnalysisResult[]> {
  const out: AnalysisResult[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("OllamaProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("constructor throws descriptively without a model", () => {
    expect(() => new OllamaProvider({ model: "" })).toThrow(
      /\[nobait:ollama\]/,
    );
    expect(() => new OllamaProvider({ model: "   " })).toThrow(
      /model is required/,
    );
  });

  test("constructor rejects non-positive timeouts", () => {
    expect(() => new OllamaProvider({ model: "m", timeoutMs: 0 })).toThrow(
      /positive/,
    );
    expect(() => new OllamaProvider({ model: "m", timeoutMs: -5 })).toThrow(
      /positive/,
    );
  });

  test("empty batch yields nothing, makes no network call", async () => {
    const fetchFn = vi.fn();
    const p = new OllamaProvider({ model: "qwen3:0.6b", fetchFn });
    const results = await collect(p.analyzeBatch([]));
    expect(results).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("sends correct POST body: model, messages, low temperature", async () => {
    const batch = mkBatch(2);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(chatResponse(validJsonFor(batch)));
    const p = new OllamaProvider({
      model: "qwen3:0.6b",
      baseUrl: "http://localhost:11434/",
      fetchFn,
    });

    await collect(p.analyzeBatch(batch));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string) as {
      model: string;
      temperature: number;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("qwen3:0.6b");
    expect(body.temperature).toBeCloseTo(0.1);
    expect(body.stream).toBe(false);
    expect(body.messages[0]!.role).toBe("system");
    expect(body.messages[1]!.role).toBe("user");
    // System prompt carries the six-tier discipline
    expect(body.messages[0]!.content).toContain("legitimate");
    expect(body.messages[0]!.content).toContain("unsure");
  });

  test("parses a valid response and yields per-video results", async () => {
    const batch = mkBatch(3);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(chatResponse(validJsonFor(batch)));
    const p = new OllamaProvider({ model: "m", fetchFn });

    const results = await collect(p.analyzeBatch(batch));
    expect(results.length).toBe(3);
    expect(results[0]!.videoId).toBe("vid_00");
    expect(results[0]!.rewrittenTitle).toBe("Rewritten 0");
    expect(results[0]!.stamp).toBe(StampTier.LEGITIMATE);
  });

  test("malformed model output → UNSURE + original title passthrough", async () => {
    const batch = mkBatch(2);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(chatResponse('Here are my thoughts! {"not": "json"}'));
    const p = new OllamaProvider({ model: "m", fetchFn });

    const results = await collect(p.analyzeBatch(batch));
    for (const r of results) {
      expect(r.stamp).toBe(StampTier.UNSURE);
      expect(r.rewrittenTitle.startsWith("Title ")).toBe(true); // original
    }
  });

  test("empty model content → descriptive Error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(chatResponse(""));
    const p = new OllamaProvider({ model: "m", fetchFn });
    await expect(collect(p.analyzeBatch(mkBatch(1)))).rejects.toThrow(
      /\[nobait:ollama\] empty response/,
    );
  });

  test("HTTP error status → descriptive Error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("<html>Bad Gateway</html>", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );
    const p = new OllamaProvider({ model: "m", fetchFn });
    await expect(collect(p.analyzeBatch(mkBatch(1)))).rejects.toThrow(
      /HTTP 502/,
    );
  });

  test("network failure (TypeError) → descriptive Error mentioning the URL", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const p = new OllamaProvider({
      model: "m",
      baseUrl: "http://localhost:9999",
      fetchFn,
    });
    await expect(collect(p.analyzeBatch(mkBatch(1)))).rejects.toThrow(
      /cannot reach http:\/\/localhost:9999/,
    );
  });

  test("hard timeout → aborts and rejects with timeout Error", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
      );
      const p = new OllamaProvider({ model: "m", timeoutMs: 50, fetchFn });
      const promise = collect(p.analyzeBatch(mkBatch(1)));
      vi.advanceTimersByTime(51);
      await expect(promise).rejects.toThrow(/hard timeout/);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not mutate the input batch", async () => {
    const batch = mkBatch(2);
    const snapshot = JSON.parse(JSON.stringify(batch));
    const fetchFn = vi
      .fn()
      .mockResolvedValue(chatResponse(validJsonFor(batch)));
    const p = new OllamaProvider({ model: "m", fetchFn });

    await collect(p.analyzeBatch(batch));
    expect(JSON.parse(JSON.stringify(batch))).toEqual(snapshot);
  });

  test("splits batches larger than MAX_BATCH_SIZE into multiple calls", async () => {
    const big = mkBatch(25);
    const fetchImpl = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        messages: { content: string }[];
      };
      // Parse the batch payload out of the user message to answer correctly.
      const userMsg = body.messages[1]!.content;
      const jsonStart = userMsg.indexOf("[");
      const payload = JSON.parse(userMsg.slice(jsonStart)) as Array<{
        id: string;
      }>;
      return chatResponse(
        JSON.stringify(
          payload.map((v) => ({
            id: v.id,
            title: "R",
            tier: "legitimate",
            reason: "ok",
          })),
        ),
      );
    };
    const fetchFn = vi.fn(fetchImpl) as unknown as typeof fetch;
    const p = new OllamaProvider({ model: "m", fetchFn });

    const results = await collect(p.analyzeBatch(big));
    expect(fetchFn).toHaveBeenCalledTimes(2); // 20 + 5
    expect(results.length).toBe(25);
  });

  test("close() aborts in-flight requests", async () => {
    const fetchFn = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    const p = new OllamaProvider({ model: "m", fetchFn });
    const promise = collect(p.analyzeBatch(mkBatch(1)));
    p.close();
    await expect(promise).rejects.toThrow();
  });

  test("suggested model list includes known small models", () => {
    expect(SUGGESTED_MODELS).toContain("qwen3:0.6b");
  });
});

describe("probeEndpoint()", () => {
  test("resolves true on reachable endpoint", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await probeEndpoint("http://localhost:11434", fetchFn)).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://localhost:11434/v1/models",
      expect.anything(),
    );
  });

  test("resolves false on unreachable endpoint", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    expect(await probeEndpoint("http://nowhere:1/", fetchFn)).toBe(false);
  });
});

describe("validateBaseUrl() — SSRF guard", () => {
  test("accepts plain http origins and strips path/trailing slash", () => {
    const v = validateBaseUrl("http://localhost:11434/");
    expect("origin" in v && v.origin).toBe("http://localhost:11434");
  });

  test("accepts https origins", () => {
    const v = validateBaseUrl("https://my-server.example.com:8443/ollama");
    expect("origin" in v && v.origin).toBe(
      "https://my-server.example.com:8443",
    );
  });

  test("rejects non-http(s) schemes (file:, ftp:, chrome:)", () => {
    for (const bad of [
      "file:///etc/passwd",
      "ftp://host/x",
      "chrome://settings",
    ]) {
      const v = validateBaseUrl(bad);
      expect("error" in v).toBe(true);
      expect("error" in v ? v.error.message : "").toMatch(
        /scheme must be http or https/,
      );
    }
  });

  test("rejects URLs with embedded credentials", () => {
    const v = validateBaseUrl("http://user:secret@localhost:11434");
    expect("error" in v).toBe(true);
    expect("error" in v ? v.error.message : "").toMatch(/credentials/);
  });

  test("rejects unparseable URLs", () => {
    const v = validateBaseUrl("not a url");
    expect("error" in v).toBe(true);
    expect("error" in v ? v.error.message : "").toMatch(/invalid URL/);
  });

  test("constructor fails fast on invalid baseUrl", () => {
    expect(
      () => new OllamaProvider({ model: "m", baseUrl: "file:///etc" }),
    ).toThrow(/scheme must be http or https/);
    expect(
      () => new OllamaProvider({ model: "m", baseUrl: "http://a:b@host" }),
    ).toThrow(/credentials/);
  });
});
