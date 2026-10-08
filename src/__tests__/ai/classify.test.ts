import { describe, it, expect } from 'vitest';
import { parseStampTier, parseBatchItem } from '../../ai/classify';
import { StampTier } from '../../stamps/types';

describe('classify - strict parsing', () => {
  describe('parseStampTier', () => {
    it.each([
      ['legitimate', StampTier.LEGITIMATE],
      ['exaggerated', StampTier.EXAGGERATED],
      ['misleading', StampTier.MISLEADING],
      ['clickbait', StampTier.CLICKBAIT],
      ['fake', StampTier.FAKE],
      ['unsure', StampTier.UNSURE],
      ['LEGITIMATE', StampTier.LEGITIMATE],
      [' Legitimate ', StampTier.LEGITIMATE],
    ])('parses valid tier "%s" → %s', (input, expected) => {
      const result = parseStampTier(input);
      expect(result.tier).toBe(expected);
      expect(result.explanation).toBeUndefined();
    });

    it.each([
      ['invalid'],
      [''],
      [null],
      [undefined],
      [123],
      ['LEGIT'],
      ['click-bait'],
    ] as const)('falls back to UNSURE for invalid input %s', (input) => {
      const result = parseStampTier(input);
      expect(result.tier).toBe(StampTier.UNSURE);
      expect(result.explanation).toBeDefined();
    });
  });

  describe('parseBatchItem', () => {
    it('parses a valid batch item', () => {
      const raw = {
        videoId: 'abc123',
        rewrittenTitle: 'Actual Title Here',
        stamp: 'legitimate',
        stampExplanation: 'Accurate and honest framing'
      };

      const result = parseBatchItem(raw);
      expect(result).toEqual({
        videoId: 'abc123',
        rewrittenTitle: 'Actual Title Here',
        stamp: StampTier.LEGITIMATE,
        stampExplanation: 'Accurate and honest framing'
      });
    });

    it('defaults to UNSURE for malformed stamp', () => {
      const raw = {
        videoId: 'abc123',
        rewrittenTitle: 'Actual Title Here',
        stamp: 'not-a-valid-tier',
        stampExplanation: 'Some explanation'
      };

      const result = parseBatchItem(raw);
      expect(result?.stamp).toBe(StampTier.UNSURE);
      expect(result?.stampExplanation).toBe('Some explanation');
    });

    it('falls back to generated explanation when stampExplanation missing', () => {
      const result = parseBatchItem({
        videoId: 'abc124',
        rewrittenTitle: 'Actual Title Here',
        stamp: 'garbage'
      });
      expect(result?.stamp).toBe(StampTier.UNSURE);
      expect(result?.stampExplanation).toContain('Unknown stamp');
    });

    it('returns null for missing videoId', () => {
      const result = parseBatchItem({
        videoId: '',
        rewrittenTitle: 'Title',
        stamp: 'legitimate',
        stampExplanation: 'Explain'
      });
      expect(result).toBeNull();
    });

    it('returns null for non-object input', () => {
      expect(parseBatchItem(null)).toBeNull();
      expect(parseBatchItem('string')).toBeNull();
      expect(parseBatchItem(123)).toBeNull();
    });
  });
});
