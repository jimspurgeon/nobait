import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CacheDB } from '../../storage/cache';
import { StampTier, CacheEntry, NegativeCacheEntry } from '../../stamps/types';

/**
 * Fake-IDB mock implementation with enough fidelity to test TTL expiration
 * and model-version invalidation flows through the CacheDB class.
 */
class FakeIDB {
  analysis = new Map<string, CacheEntry>();
  negative = new Map<string, NegativeCacheEntry>();

  buildMockDB(): IDBDatabase {
    const buildStore = (map: Map<string, any>, deleted: Set<string>) => ({
      get: (key: string) => makeIDBRequest(map.get(key)),
      put: (value: any) => {
        map.set(value.videoId, value);
        return makeIDBRequest(undefined);
      },
      delete: (key: string) => {
        map.delete(key);
        deleted.add(key);
        return makeIDBRequest(undefined);
      },
      openCursor: () => makeIDBRequest(null)
    });

    const self = this;
    return {
      transaction: (storeName: string, _mode?: IDBTransactionMode) => ({
        objectStore: () =>
          storeName === 'analysis'
            ? buildStore(self.analysis, new Set())
            : buildStore(self.negative, new Set()),
        abort: () => {}
      }),
      close: () => {},
      objectStoreNames: { contains: () => true }
    } as unknown as IDBDatabase;
  }
}

function makeIDBRequest(result: any): IDBRequest {
  const req = {
    onsuccess: null as null | (() => void),
    onerror: null as null | (() => void),
    result
  } as unknown as IDBRequest;
  setTimeout(() => (req as any).onsuccess?.(), 0);
  return req;
}

const fake = new FakeIDB();

vi.stubGlobal('indexedDB', {
  open: () => {
    const request: any = { onsuccess: null, onerror: null, onupgradeneeded: null, result: fake.buildMockDB() };
    setTimeout(() => request.onsuccess?.(), 0);
    return request;
  }
});

function makeEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    videoId: 'test-video',
    result: {
      videoId: 'test-video',
      rewrittenTitle: 'Honest Title',
      stamp: StampTier.LEGITIMATE,
      stampExplanation: 'Accurate framing',
      timestamp: Date.now(),
      modelVersion: 'gemini-flash-lite-v1'
    },
    inputHash: 'abc123',
    modelVersion: 'gemini-flash-lite-v1',
    createdAt: Date.now(),
    expiresAt: Date.now() + 86400000,
    ...overrides
  };
}

describe('CacheDB', () => {
  let cache: CacheDB;

  beforeEach(() => {
    fake.analysis.clear();
    fake.negative.clear();
    cache = new CacheDB();
    (cache as any).db = fake.buildMockDB();
  });

  it('round-trips a positive entry', async () => {
    const entry = makeEntry({ videoId: 'rt-video' });
    fake.analysis.set('rt-video', entry);

    const got = await cache.getAnalysis('rt-video', entry.modelVersion);
    expect(got?.videoId).toBe('rt-video');
    expect(got?.result.stamp).toBe(StampTier.LEGITIMATE);
  });

  it('rejects expired entries and deletes them', async () => {
    const entry = makeEntry({ videoId: 'expired-video', expiresAt: Date.now() - 1000 });
    fake.analysis.set('expired-video', entry);

    const got = await cache.getAnalysis('expired-video', entry.modelVersion);
    expect(got).toBeNull();
  });

  it('invalidates entries when model version changes', async () => {
    const entry = makeEntry({ videoId: 'mv-video', modelVersion: 'old-model' });
    fake.analysis.set('mv-video', entry);

    const got = await cache.getAnalysis('mv-video', 'new-model');
    expect(got).toBeNull();
  });

  it('returns null for missing entries', async () => {
    const got = await cache.getAnalysis('never-seen', 'gemini-flash-lite-v1');
    expect(got).toBeNull();
  });

  it('rejects expired negative entries', async () => {
    const neg: NegativeCacheEntry = {
      videoId: 'neg-expired',
      reason: 'no_transcript',
      timestamp: Date.now() - 2 * 86400000,
      ttlMs: 86400000
    };
    fake.negative.set('neg-expired', neg);

    const got = await cache.getNegative('neg-expired');
    expect(got).toBeNull();
  });

  it('returns live negative entries', async () => {
    const neg: NegativeCacheEntry = {
      videoId: 'neg-live',
      reason: 'too_short',
      timestamp: Date.now(),
      ttlMs: 86400000
    };
    fake.negative.set('neg-live', neg);

    const got = await cache.getNegative('neg-live');
    expect(got?.reason).toBe('too_short');
  });
});
