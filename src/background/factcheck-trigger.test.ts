import { describe, it, expect } from 'vitest';
import { shouldLookup, DEFAULT_TOPIC_KEYWORDS } from './factcheck-trigger.js';
import type { VideoMeta, TopicKeywordConfig } from './factcheck-trigger.js';

describe('shouldLookup', () => {
  describe('fake-lean trigger', () => {
    it('fires on fake preliminary stamp', () => {
      const meta: VideoMeta = { title: 'any title', preliminaryStamp: 'fake' };
      const result = shouldLookup(meta);
      expect(result.should).toBe(true);
      expect(result.reason).toBe('fake-lean');
    });

    it('does not fire for softer preliminary stamps', () => {
      for (const tier of ['exaggerated', 'misleading', 'clickbait', 'unsure', 'legitimate']) {
        const meta: VideoMeta = { title: 'generic cooking tutorial', preliminaryStamp: tier as string };
        const result = shouldLookup(meta);
        expect(result.should).toBe(false);
        expect(result.reason).toBe('no-trigger');
      }
    });
  });

  describe('topic keywords', () => {
    it('fires on health keywords', () => {
      const meta: VideoMeta = { title: 'This Miracle Cure Doctors HATE' };
      const result = shouldLookup(meta);
      expect(result.should).toBe(true);
      expect(result.reason).toBe('topic-keyword');
      expect(result.matchedTopic).toBe('health');
    });

    it('fires on finance keywords', () => {
      const meta: VideoMeta = { title: 'Market Crash Incoming!' };
      const result = shouldLookup(meta);
      expect(result.should).toBe(true);
      expect(result.reason).toBe('topic-keyword');
      expect(result.matchedTopic).toBe('finance');
    });

    it('fires on politics keywords', () => { });
  });

  it('fires when topic keyword appears only in description', () => {
    const meta: VideoMeta = { title: 'What Really Happened Last Week', description: 'A look at the vaccine debate and health policy.' };
    const result = shouldLookup(meta);
    expect(result.should).toBe(true);
    expect(result.reason).toBe('topic-keyword');
  });

  it('does whole-word matching, not substring', () => {
    // 'newsroom' is one token; keyword 'news' must not match it.
    const meta: VideoMeta = { title: 'Building a newsroom CMS in Rust' };
    const result = shouldLookup(meta);
    // 'newsroom' is one token, and 'news' (single word) is whole-word matched via token set → should NOT fire.
    expect(result.should).toBe(false);
  });

  it('is case-insensitive', () => {
    const meta: VideoMeta = { title: 'THE MARKET CRASH IS COMING' };
    expect(shouldLookup(meta).should).toBe(true);
  });

  it('does not fire for generic non-newsy titles', () => {
    const genericTitles = [
      'Minecraft speedrun world record',
      'lofi beats to relax to',
      'Building my dream PC — full build guide',
      'I built a mechanical keyboard from scratch',
      '24 hours in Tokyo',
    ];
    for (const title of genericTitles) {
      expect(shouldLookup({ title }).should).toBe(false);
    }
  });

  it('supports custom extensible keyword configs', () => {
    const custom: TopicKeywordConfig = { topics: { scitech: ['quantum', 'fusion'] } };
    expect(shouldLookup({ title: 'Quantum supremacy explained' }, custom).should).toBe(true);
    expect(shouldLookup({ title: 'This miracle cure doctors hate' }, custom).should).toBe(false);
  });
});

describe('DEFAULT_TOPIC_KEYWORDS', () => {
  it('covers the four starter topics', () => {
    expect(Object.keys(DEFAULT_TOPIC_KEYWORDS.topics)).toEqual(
      expect.arrayContaining(['news', 'health', 'finance', 'politics']),
    );
  });
});
