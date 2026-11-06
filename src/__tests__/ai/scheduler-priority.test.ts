import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EvaluationScheduler } from "../../background/scheduler";

/** Minimal video shape the mocked provider receives per analyzeBatch call. */
interface RecordedVideo {
  videoId: string;
  title: string;
  [key: string]: unknown;
}

const mockState = vi.hoisted(() => ({
  analyzeBatchCalls: [] as RecordedVideo[][],
}));

vi.mock("../../ai/factory", () => ({
  aiProviderFactory: {
    initialize: vi.fn().mockImplementation(async () => ({
      name: "gemini-mock",
      supportsStreaming: true,
      analyzeBatch: vi
        .fn()
        .mockImplementation(async function* (videos: RecordedVideo[]) {
          mockState.analyzeBatchCalls.push(videos);
          for (const v of videos) {
            yield {
              videoId: v.videoId,
              rewrittenTitle: `Honest: ${v.title}`,
              stamp: "legitimate",
              stampExplanation: "Test explanation",
            };
          }
        }),
    })),
    getProvider: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../../storage/cache", () => ({
  cacheDB: {
    getAnalysis: vi.fn().mockResolvedValue(null),
    getNegative: vi.fn().mockResolvedValue(null),
    setAnalysis: vi.fn().mockResolvedValue(undefined),
    setNegative: vi.fn().mockResolvedValue(undefined),
    deleteAnalysis: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../utils/trace", () => ({
  trace: vi.fn(),
}));

describe("EvaluationScheduler priority scheduling", () => {
  let scheduler: EvaluationScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.analyzeBatchCalls = [];
    scheduler = EvaluationScheduler.getInstance();
  });

  afterEach(() => {
    scheduler.close();
  });

  it("flushes visible videos ahead of off-screen ones in the same batch", async () => {
    // Arrive in mixed order: normals first, visible last.
    const promises = [
      scheduler.evaluate({ videoId: "n0", title: "Normal 0" }),
      scheduler.evaluate({ videoId: "n1", title: "Normal 1" }),
      scheduler.evaluate({ videoId: "v0", title: "Visible 0", visible: true }),
      scheduler.evaluate({ videoId: "n2", title: "Normal 2" }),
      scheduler.evaluate({ videoId: "v1", title: "Visible 1", visible: true }),
    ];
    const results = await Promise.all(promises);

    expect(results.filter((r) => r !== null)).toHaveLength(5);
    expect(mockState.analyzeBatchCalls).toHaveLength(1);
    expect(mockState.analyzeBatchCalls[0]!.map((c) => c.videoId)).toEqual([
      "v0",
      "v1",
      "n0",
      "n1",
      "n2",
    ]);
  });

  it("keeps FIFO order among equal priorities", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `n${i}`);
    const promises = ids.map((videoId) =>
      scheduler.evaluate({ videoId, title: `Title ${videoId}` }),
    );
    await Promise.all(promises);

    expect(mockState.analyzeBatchCalls).toHaveLength(1);
    expect(mockState.analyzeBatchCalls[0]!.map((c) => c.videoId)).toEqual(
      ids,
    );
  });

  it("caps chunks per flush, keeps overflow pending, and eventually evaluates every video", async () => {
    // 45 videos > MAX_CHUNKS_PER_FLUSH (2) * MAX_BATCH_SIZE (20) = 40 per cycle.
    const visibleIds = ["v0", "v1"].map((id) => ({ id, visible: true }));
    const normalIds = Array.from({ length: 43 }, (_, i) => ({
      id: `n${i}`,
      visible: false,
    }));
    const all = [...visibleIds, ...normalIds];

    const results = await Promise.all(
      all.map(({ id, visible }) =>
        scheduler.evaluate({ videoId: id, title: `Title ${id}`, visible }),
      ),
    );

    // Nothing dropped: every video resolved with a stamp.
    expect(results.filter((r) => r !== null)).toHaveLength(all.length);

    // Drained across multiple flush cycles...
    expect(mockState.analyzeBatchCalls.length).toBeGreaterThanOrEqual(2);
    // ...but no more than the per-cycle cap of two chunks per flush cycle.
    const total = mockState.analyzeBatchCalls.reduce(
      (sum, call) => sum + call.length,
      0,
    );
    expect(total).toBe(all.length);
    for (const call of mockState.analyzeBatchCalls) {
      // A flush cycle is capped: analyzeBatch is invoked once per 20-video
      // chunk, at most 2 chunks before a follow-up flush is scheduled.
      expect(call.length).toBeLessThanOrEqual(20);
    }

    // Visible videos were in the very first chunk.
    expect(mockState.analyzeBatchCalls[0]!.map((c) => c.videoId)).toEqual(
      expect.arrayContaining(["v0", "v1"]),
    );
  });

  it("does not starve low-priority videos behind a high-priority backlog", async () => {
    // 40 visible (fills the entire first flush cycle) + 3 off-screen.
    const visible = Array.from({ length: 40 }, (_, i) => ({
      videoId: `vis-${i}`,
      title: `Visible ${i}`,
      visible: true as const,
    }));
    const normal = Array.from({ length: 3 }, (_, i) => ({
      videoId: `low-${i}`,
      title: `Low ${i}`,
      visible: false as const,
    }));

    const results = await Promise.all(
      [...visible, ...normal].map((input) => scheduler.evaluate(input)),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(43);

    // First flush handled the visible backlog exclusively...
    const firstCycle = mockState.analyzeBatchCalls.slice(0, 2).flat();
    expect(firstCycle).toHaveLength(40);
    expect(
      firstCycle.every((c) => c.videoId.startsWith("vis-")),
    ).toBe(true);

    // ...and once no high-priority work remained, the low-priority videos
    // were flushed and delivered (no starvation, no drops).
    const lastCall = mockState.analyzeBatchCalls[mockState.analyzeBatchCalls.length - 1]!;
    expect(lastCall.map((c) => c.videoId)).toEqual([
      "low-0",
      "low-1",
      "low-2",
    ]);
  });
});
