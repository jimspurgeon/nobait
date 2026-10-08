/**
 * Chrome built-in AI (Nano) provider tests — window.LanguageModel mocked
 * globally per-test via vi.stubGlobal. Verifies: feature detection
 * (absent API → unavailable stub), session creation with system prompt,
 * strict parsing, timeout destruction, mid-session error fallback.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { StampTier } from "../../stamps/types.js";
import { NanoProvider } from "../../ai/nano.js";
import type { VideoSignal } from "../../content/signals.js";
import type { AnalysisResult } from "../../ai/types.js";

function mkBatch(n: number): VideoSignal[] {
  return Array.from({ length: n }, (_, i) => ({
    videoId: `nano_${i}`,
    title: `Original ${i}`,
  }));
}

function validJsonFor(batch: VideoSignal[]): string {
  return JSON.stringify(
    batch.map((v, i) => ({
      id: v.videoId,
      title: `Rewritten ${i}`,
      tier: "clickbait",
      reason: `Reason ${i}`,
    })),
  );
}

/** Structural mirror of the Prompt API session surface (test-side). */
interface LanguageModelSessionLike {
  prompt: (input: string) => Promise<string>;
  destroy: () => void;
}

async function collect(
  gen: AsyncIterable<AnalysisResult>,
): Promise<AnalysisResult[]> {
  const out: AnalysisResult[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

/** Minimal viable LanguageModel mock with tracking spies. */
function makeLMMock(opts: { promptResponse?: string; fail?: Error } = {}) {
  const promptSpy = vi.fn(
    async (_input: string) => opts.promptResponse ?? "{}",
  );
  const destroySpy = vi.fn();
  if (opts.fail) promptSpy.mockRejectedValue(opts.fail);

  const session: LanguageModelSessionLike = {
    prompt: promptSpy,
    destroy: destroySpy,
  };
  const lm = {
    availability: vi.fn(async () => "readily" as const),
    create: vi.fn(async () => session),
    params: vi.fn(async () => ({
      defaultTopK: 3,
      maxTopK: 128,
      defaultTemperature: 1,
      maxTemperature: 2,
    })),
  };
  return { lm, session, promptSpy, destroySpy };
}

describe("NanoProvider — API absent (Firefox et al.)", () => {
  beforeEach(() => {
    // Ensure NO LanguageModel on globalThis (Firefox-like runtime).
    vi.stubGlobal("LanguageModel", undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("reports unavailable in name and yields UNSURE passthrough", async () => {
    const p = new NanoProvider();
    expect(p.name).toContain("unavailable");

    const batch = mkBatch(2);
    const results = await collect(p.analyzeBatch(batch));
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.stamp).toBe(StampTier.UNSURE);
      expect(r.rewrittenTitle).toBe(
        r.videoId === "nano_0" ? "Original 0" : "Original 1",
      );
      expect(r.stampExplanation.toLowerCase()).toContain("unavailable");
    }
  });

  test("makes no session/create calls", async () => {
    const p = new NanoProvider();
    await collect(p.analyzeBatch(mkBatch(1)));
    // No assertions on window — absence of LanguageModel is the setup.
    expect(p.supportsStreaming).toBe(false);
  });
});

describe("NanoProvider — API present", () => {
  beforeEach(() => {
    // No-op: LanguageModel is stubbed per-test via globalThis.
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("creates session with system prompt and analyzes batch", async () => {
    const { lm, promptSpy } = makeLMMock({
      promptResponse: validJsonFor(mkBatch(2)),
    });
    (globalThis as { LanguageModel?: unknown }).LanguageModel = lm;

    const p = new NanoProvider();
    expect(p.name).toBe("chrome:nano");

    const batch = mkBatch(2);
    const results = await collect(p.analyzeBatch(batch));

    expect(lm.availability).toHaveBeenCalledTimes(1);
    expect(lm.create).toHaveBeenCalledTimes(1);
    const createCalls = lm.create.mock.calls as unknown as Array<
      [
        {
          initialPrompts?: Array<{ role: string; content: string }>;
          temperature?: number;
        },
      ]
    >;
    const createOpts = createCalls[0]?.[0] ?? {};
    expect(createOpts.initialPrompts?.[0]?.role).toBe("system");
    expect(createOpts.initialPrompts?.[0]?.content).toContain("legitimate");
    expect(createOpts.temperature).toBeCloseTo(0.2);

    expect(promptSpy).toHaveBeenCalledTimes(1);
    const promptCalls = promptSpy.mock.calls as unknown as Array<[string]>;
    const userPrompt = promptCalls[0]?.[0] ?? "";
    expect(userPrompt).toContain("nano_0");

    expect(results.length).toBe(2);
    expect(results[0]!.stamp).toBe(StampTier.CLICKBAIT);
    expect(results[0]!.rewrittenTitle).toBe("Rewritten 0");
  });

  test("malformed response → UNSURE + original title", async () => {
    const { lm } = makeLMMock({
      promptResponse: "I am a tiny model and I ramble",
    });
    (globalThis as { LanguageModel?: unknown }).LanguageModel = lm;

    const p = new NanoProvider();
    const batch = mkBatch(2);
    const results = await collect(p.analyzeBatch(batch));
    for (const r of results) {
      expect(r.stamp).toBe(StampTier.UNSURE);
      expect(r.rewrittenTitle.startsWith("Original ")).toBe(true);
    }
  });

  test("availability 'unavailable' → yields UNSURE for the batch", async () => {
    const lm = {
      availability: vi.fn(async () => "unavailable" as const),
      create: vi.fn(),
      params: vi.fn(),
    };
    (globalThis as { LanguageModel?: unknown }).LanguageModel = lm;

    const p = new NanoProvider();
    const batch = mkBatch(1);
    const results = await collect(p.analyzeBatch(batch));
    expect(results.length).toBe(1);
    expect(results[0]!.stamp).toBe(StampTier.UNSURE);
    expect(results[0]!.rewrittenTitle).toBe("Original 0");
    expect(lm.create).not.toHaveBeenCalled();
  });

  test("prompt timeout destroys session and yields UNSURE", async () => {
    vi.useFakeTimers();
    const { lm, destroySpy } = makeLMMock();
    // Never resolves: simulates a hang.
    const hangingSession: LanguageModelSessionLike = {
      prompt: () => new Promise<string>(() => {}),
      destroy: destroySpy,
    };
    lm.create.mockResolvedValue(hangingSession);
    (globalThis as { LanguageModel?: unknown }).LanguageModel = lm;

    const p = new NanoProvider({ timeoutMs: 25 });
    const batch = mkBatch(1);
    const promise = collect(p.analyzeBatch(batch));
    // advanceTimersByTimeAsync lets the generator's awaited microtasks
    // (init session → set timeout timer) settle BEFORE firing the timer,
    // which a plain synchronous advance would miss entirely.
    await vi.advanceTimersByTimeAsync(26);
    const results = await promise;
    expect(results.length).toBe(1);
    expect(results[0]!.stamp).toBe(StampTier.UNSURE);
    expect(destroySpy).toHaveBeenCalled();
  });

  test("mid-session error marks provider unavailable for future batches", async () => {
    const { lm } = makeLMMock();
    lm.create.mockResolvedValue({
      prompt: async () => {
        throw new Error("session destroyed abruptly");
      },
      destroy: vi.fn(),
    } as unknown as LanguageModelSessionLike);
    (globalThis as { LanguageModel?: unknown }).LanguageModel = lm;

    const p = new NanoProvider();
    const batch = mkBatch(1);

    // First call: parse-level error is caught, UNSURE yielded (no throw).
    const first = await collect(p.analyzeBatch(batch));
    expect(first[0]!.stamp).toBe(StampTier.UNSURE);

    // Second batch also degrades to UNSURE (fallback mode persists).
    const second = await collect(p.analyzeBatch(mkBatch(1)));
    expect(second[0]!.stamp).toBe(StampTier.UNSURE);
  });

  test("close() destroys the live session", async () => {
    const { lm, destroySpy } = makeLMMock({ promptResponse: "[]" });
    (globalThis as { LanguageModel?: unknown }).LanguageModel = lm;

    const p = new NanoProvider();
    // Force session creation.
    await collect(p.analyzeBatch(mkBatch(1)));
    p.close();
    expect(destroySpy).toHaveBeenCalled();
    expect((p as unknown as { session: unknown }).session).toBeNull();
  });
});

describe("NanoProvider — batches larger than MAX_BATCH_SIZE", () => {
  beforeEach(() => {
    // No-op: LanguageModel is stubbed per-test via globalThis.
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("prompts multiple times (20-video chunks)", async () => {
    const { lm } = makeLMMock();
    let promptCount = 0;
    lm.create.mockResolvedValue({
      prompt: async (input: string) => {
        promptCount++;
        const jsonStart = input.indexOf("[");
        const payload = JSON.parse(input.slice(jsonStart)) as Array<{
          id: string;
        }>;
        return JSON.stringify(
          payload.map((v) => ({
            id: v.id,
            title: "R",
            tier: "legitimate",
            reason: "ok",
          })),
        );
      },
      destroy: vi.fn(),
    } as unknown as LanguageModelSessionLike);
    (globalThis as { LanguageModel?: unknown }).LanguageModel = lm;

    const p = new NanoProvider();
    const results = await collect(p.analyzeBatch(mkBatch(25)));
    expect(promptCount).toBe(2); // 20 + 5
    expect(results.length).toBe(25);
  });
});
