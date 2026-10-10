/**
 * WasmProvider unit tests — contract, chunking, lazy load, error fallback.
 * The wllama loader is always injected; no network, no WebAssembly.
 */
import { describe, test, expect, vi } from "vitest";
import {
  WasmProvider,
  BUILTIN_MODELS,
  WASM_BATCH_CHUNK,
} from "../../ai/wasm.js";
import { StampTier } from "../../stamps/types.js";
import type { VideoSignal } from "../../content/signals.js";
import type { WllamaLike } from "../../ai/wasm.js";

function signal(id: string, title: string): VideoSignal {
  return { videoId: id, title } as VideoSignal;
}

/** Valid model JSON for a chunk of videos. */
function modelJson(ids: string[]): string {
  return JSON.stringify(
    ids.map((id) => ({
      id,
      title: `neutral-${id}`,
      tier: "legitimate",
      reason: `honest title for ${id}`,
    })),
  );
}

function makeWllama(opts: {
  reply?: (msgs: Array<{ role: string; content: string }>) => string;
  onLoad?: () => void;
} = {}): WllamaLike {
  return {
    loadModelFromUrl: vi.fn(async (_u: string[], _c: Record<string, unknown>) => {
      opts.onLoad?.();
    }),
    createChatCompletion: vi.fn(async (msgs) =>
      opts.reply ? opts.reply(msgs) : "[]",
    ),
    exit: vi.fn(async () => {}),
  };
}

describe("WasmProvider", () => {
  test("contract: name, no streaming, supported gate", () => {
    const p = new WasmProvider({
      loader: async () => makeWllama(),
      runtimeSupported: true,
    });
    expect(p.name).toBe("builtin-wasm");
    expect(p.supportsStreaming).toBe(false);
    expect(p.supported).toBe(true);
  });

  test("default model is the Qwen catalogue entry", () => {
    expect(BUILTIN_MODELS["qwen2.5-0.5b"].urls.length).toBe(1);
    expect(BUILTIN_MODELS["qwen2.5-0.5b"].urls[0]).toMatch(/qwen2\.5-0\.5b/);
  });

  test("analyzeBatch yields parsed results per chunk", async () => {
    const batch = [signal("a", "t"), signal("b", "t"), signal("c", "t"), signal("d", "t")];
    let call = 0;
    const wllama = makeWllama({
      reply: (msgs) => {
        const prompt = msgs[1]!.content;
        call++;
        if (call === 1) return modelJson(["a", "b", "c"]);
        expect(prompt).toContain("1 video");
        return modelJson(["d"]);
      },
    });
    const p = new WasmProvider({
      loader: async () => wllama,
      runtimeSupported: true,
    });

    const out = [];
    for await (const r of p.analyzeBatch(batch)) out.push(r);
    expect(out.map((r) => r.videoId)).toEqual(["a", "b", "c", "d"]);
    expect(out[0]!.stamp).toBe(StampTier.LEGITIMATE);
    expect(call).toBe(2); // 4 videos / chunk size 3
  });

  test("chunks capped at WASM_BATCH_CHUNK", async () => {
    const wllama = makeWllama({
      reply: (msgs) => {
        // Every prompt asks about <= WASM_BATCH_CHUNK videos
        const m = msgs[1]!.content.match(/Analyze these (\d+) video/);
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBeLessThanOrEqual(WASM_BATCH_CHUNK);
        return "[]";
      },
    });
    const p = new WasmProvider({
      loader: async () => wllama,
      runtimeSupported: true,
    });
    const batch = Array.from({ length: 10 }, (_, i) => signal(`v${i}`, `t${i}`));
    const out = [];
    for await (const r of p.analyzeBatch(batch)) out.push(r);
    expect(out).toHaveLength(10);
    // No verdicts parsed → all UNSURE + original title passthrough
    expect(out.every((r) => r.stamp === StampTier.UNSURE)).toBe(true);
    expect(out.every((r) => r.rewrittenTitle.startsWith("t"))).toBe(true);
  });

  test("completion failure yields UNSURE/original for that chunk only", async () => {
    let call = 0;
    const wllama = makeWllama({
      reply: () => {
        call++;
        if (call === 1) throw new Error("OOM");
        return modelJson(["d"]);
      },
    });
    const p = new WasmProvider({
      loader: async () => wllama,
      runtimeSupported: true,
    });
    const batch = [signal("a", "A"), signal("b", "B"), signal("c", "C"), signal("d", "D")];
    const out = [];
    for await (const r of p.analyzeBatch(batch)) out.push(r);
    expect(out[0]!.stamp).toBe(StampTier.UNSURE);
    expect(out[0]!.rewrittenTitle).toBe("A");
    expect(out[3]!.stamp).toBe(StampTier.LEGITIMATE);
  });

  test("model loads lazily on first analyze, once across batches", async () => {
    let loads = 0;
    const wllama = makeWllama({ onLoad: () => loads++ });
    const p = new WasmProvider({
      loader: async () => wllama,
      runtimeSupported: true,
    });
    expect(loads).toBe(0);
    for await (const _ of p.analyzeBatch([signal("x", "X")])) break;
    expect(loads).toBe(1);
    for await (const _ of p.analyzeBatch([signal("y", "Y")])) break;
    expect(loads).toBe(1);
  });

  test("ensureModel throws descriptive Error on unsupported runtime", async () => {
    const p = new WasmProvider({
      loader: async () => makeWllama(),
      runtimeSupported: false,
    });
    const iter = p.analyzeBatch([signal("x", "X")])[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/JSPI|memory64/);
  });

  test("load failure rejects with model URL in message", async () => {
    const wllama: WllamaLike = {
      loadModelFromUrl: vi.fn(async () => {
        throw new Error("network down");
      }),
      createChatCompletion: vi.fn(async () => "[]"),
      exit: vi.fn(async () => {}),
    };
    const p = new WasmProvider({
      loader: async () => wllama,
      runtimeSupported: true,
      modelUrls: ["https://example.invalid/model.gguf"],
    });
    const iter = p.analyzeBatch([signal("x", "X")])[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/model\.gguf/);
    // Failed load is not cached; a retry re-attempts (loading reset).
    const again = p.analyzeBatch([signal("x", "X")])[Symbol.asyncIterator]();
    await expect(again.next()).rejects.toThrow(/model\.gguf/);
  });

  test("close() exits the instance and allows re-load", async () => {
    const wllama = makeWllama();
    const p = new WasmProvider({
      loader: async () => wllama,
      runtimeSupported: true,
    });
    for await (const _ of p.analyzeBatch([signal("x", "X")])) break;
    await p.close();
    expect(wllama.exit).toHaveBeenCalledTimes(1);
    for await (const _ of p.analyzeBatch([signal("y", "Y")])) break;
    expect(wllama.loadModelFromUrl).toHaveBeenCalledTimes(2);
  });

  test("download progress callback forwarded to loadModelFromUrl", async () => {
    const wllama = makeWllama();
    const onProgress = vi.fn();
    const p = new WasmProvider({
      loader: async () => wllama,
      runtimeSupported: true,
      onDownloadProgress: onProgress,
    });
    for await (const _ of p.analyzeBatch([signal("x", "X")])) break;
    const cfg = (wllama.loadModelFromUrl as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Record<string, unknown>;
    expect(cfg.progressCallback).toBe(onProgress);
  });
});
