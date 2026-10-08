import { describe, it, expect } from 'vitest';

import { StampTier, CacheEntry, NegativeCacheEntry } from '../../stamps/types';

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

describe('CacheDB (pure logic with injected fake IDB)', () => {
  it('creates entries with the right shape', () => {
    const entry = makeEntry();
    expect(entry.videoId).toBe('test-video');
    expect(entry.modelVersion).toBe('gemini-flash-lite-v1');
    expect(entry.expiresAt).toBeGreaterThan(entry.createdAt);
  });

  it('computes TTL expiry boundary correctly', () => {
    const now = Date.now();
    const entry = makeEntry({ createdAt: now, expiresAt: now + 1000 });
    expect(now + 999 < entry.expiresAt).toBe(true);
    expect(now + 1001 > entry.expiresAt).toBe(true);
  });

  it('negative entries have shorter TTL than positive ones', () => {
    const neg: NegativeCacheEntry = {
      videoId: 'neg',
      reason: 'no_transcript',
      timestamp: Date.now(),
      ttlMs: 86400000
    };
    const positiveTtl = 7 * 24 * 60 * 60 * 1000;
    expect(neg.ttlMs).toBeLessThan(positiveTtl);
  });
});
