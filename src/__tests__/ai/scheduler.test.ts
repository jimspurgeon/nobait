import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvaluationScheduler } from '../../background/scheduler';


const mockState = vi.hoisted(() => ({
  analyzeBatchCalls: [] as any[][],
  resolveFn: null as null | ((videos: any[]) => any)
}));

vi.mock('../../ai/factory', () => ({
  aiProviderFactory: {
    initialize: vi.fn().mockImplementation(async () => ({
      name: 'gemini-mock',
      supportsStreaming: true,
      // Canonical (P4) AIProvider interface: async generator yielding
      // AnalysisResults per video.
      analyzeBatch: vi.fn().mockImplementation(async function* (videos: any[]) {
        mockState.analyzeBatchCalls.push(videos);
        let results;
        if (mockState.resolveFn) {
          // resolveFn may return either a raw array or a P3-style
          // `{ results: [...] }` envelope — normalize both.
          const resolved = mockState.resolveFn(videos);
          results = Array.isArray(resolved) ? resolved : resolved.results;
        } else {
          results = videos.map((v: any) => ({
            videoId: v.videoId,
            rewrittenTitle: `Honest: ${v.title}`,
            stamp: 'legitimate',
            stampExplanation: 'Test explanation'
          }));
        }
        for (const r of (results as any[])) {
          yield {
            videoId: r.videoId,
            rewrittenTitle: r.rewrittenTitle ?? `Honest: ${r.title}`,
            stamp: r.stamp ?? 'legitimate',
            stampExplanation: r.stampExplanation ?? 'Test explanation'
          };
        }
      })
    }))
  }
}));

vi.mock('../../storage/cache', () => ({
  cacheDB: {
    getAnalysis: vi.fn().mockResolvedValue(null),
    getNegative: vi.fn().mockResolvedValue(null),
    setAnalysis: vi.fn().mockResolvedValue(undefined),
    setNegative: vi.fn().mockResolvedValue(undefined),
    deleteAnalysis: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined)
  }
}));

import { cacheDB } from '../../storage/cache';

describe('EvaluationScheduler', () => {
  let scheduler: EvaluationScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.analyzeBatchCalls = [];
    mockState.resolveFn = null;
    scheduler = EvaluationScheduler.getInstance();
    (cacheDB.getAnalysis as any) = vi.fn().mockResolvedValue(null);
    (cacheDB.getNegative as any) = vi.fn().mockResolvedValue(null);
  });

  afterEach(() => {
    scheduler.close();
  });

  describe('coalescing', () => {
    it('merges multiple evaluate() calls within 50ms into one batch', async () => {
      mockState.resolveFn = (videos: any[]) => ({
        results: videos.map((v: any) => ({
          videoId: v.videoId,
          rewrittenTitle: `Honest: ${v.title}`,
          stamp: 'legitimate',
          stampExplanation: 'Test explanation'
        }))
      });

      const promises = Array.from({ length: 20 }, (_, i) =>
        scheduler.evaluate({ videoId: `v${i}`, title: `Title ${i}` })
      );

      const results = await Promise.all(promises);
      expect(results.filter((r: any) => r !== null)).toHaveLength(20);
      expect(mockState.analyzeBatchCalls).toHaveLength(1);
      expect(mockState.analyzeBatchCalls[0]).toHaveLength(20);
    });
  });

  describe('deduplication', () => {
    it('shares a single promise for duplicate in-flight videoId', async () => {
      const [first, second] = await Promise.all([
        scheduler.evaluate({ videoId: 'dup-1', title: 'Same title' }),
        scheduler.evaluate({ videoId: 'dup-1', title: 'Same title' })
      ]);
      expect(mockState.analyzeBatchCalls.flat()).toHaveLength(1);
      // Both callers got the same result
      expect(first).toEqual(second);
      expect(first?.videoId).toBe('dup-1');
    });
  });

  describe('negative cache', () => {
    it('does not re-evaluate negative-cached videos', async () => {
      (cacheDB.getNegative as any) = vi.fn().mockResolvedValue({
        videoId: 'neg-1',
        reason: 'no_transcript',
        timestamp: Date.now(),
        ttlMs: 86400000
      });
      const result = await scheduler.evaluate({ videoId: 'neg-1', title: 'Title' });
      expect(result).toBeNull();
      expect(mockState.analyzeBatchCalls).toHaveLength(0);
    });

    it('stores negative cache for missing AI responses', async () => {
      mockState.resolveFn = () => ({ results: [] });
      const result = await scheduler.evaluate({ videoId: 'missing-1', title: 'Missing' });
      expect(result).toBeNull();
      expect(cacheDB.setNegative).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'missing-1', reason: 'unavailable' }));
    });
  });

  describe('perf micro-test', () => {
    it('cold batch of 20 videos = exactly 1 analyzeBatch call', async () => {
      mockState.resolveFn = (videos: any[]) => ({
        results: videos.map((v: any) => ({
          videoId: v.videoId,
          rewrittenTitle: `Honest: ${v.title}`,
          stamp: 'legitimate',
          stampExplanation: 'Test explanation'
        }))
      });
      const promises = Array.from({ length: 20 }, (_, i) =>
        scheduler.evaluate({ videoId: `screen-${i}`, title: `Screenful ${i}` })
      );
      await Promise.all(promises);
      expect(mockState.analyzeBatchCalls).toHaveLength(1);
      expect(mockState.analyzeBatchCalls[0]).toHaveLength(20);
    });
  });
});
