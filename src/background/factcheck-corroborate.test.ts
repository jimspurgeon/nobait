import { describe, it, expect } from 'vitest';
import {
  dominantRating,
  applyCorroboration,
  formatSourceLines,
  isStillRelevant,
} from './factcheck-corroborate.js';
import type { FactCheckClaim } from './factcheck-client.js';
import { StampTier } from './factcheck-types.js';

function makeClaim(rating: string, text = 'A claim about something', publisher = 'Snopes'): FactCheckClaim {
  return {
    id: `id-${rating}-${text.length}`,
    claimText: text,
    publisher,
    reviewUrl: `https://${publisher}.com/review`,
    textualRating: rating,
  };
}

describe('dominantRating', () => {
  it('returns null for empty claims', () => {
    expect(dominantRating([])).toBeNull();
  });

  it('false majority wins with 2/2 false', () => {
    const claims = [makeClaim('False'), makeClaim('False')];
    expect(dominantRating(claims)).toBe('false');
  });

  it('false majority with 2/3 false', () => {
    const claims = [makeClaim('False'), makeClaim('False'), makeClaim('True')];
    expect(dominantRating(claims)).toBe('false');
  });

  it('true majority with 2/3 true', () => {
    const claims = [makeClaim('True'), makeClaim('True'), makeClaim('False')];
    expect(dominantRating(claims)).toBe('true');
  });

  it('blend returns mixed', () => {
    const claims = [makeClaim('True'), makeClaim('False')];
    expect(dominantRating(claims)).toBe('mixed');
  });

  it('unclassified-only claims return mixed (conservative)', () => {
    const claims = [makeClaim('Debatable'), makeClaim('Unclear')];
    expect(dominantRating(claims)).toBe('mixed');
  });
});

describe('applyCorroboration', () => {
  it('strengthens EXAGGERATED to FAKE on false majority', () => {
    const claims = [makeClaim('False'), makeClaim('Pants on Fire')];
    const outcome = applyCorroboration(claims, StampTier.EXAGGERATED);
    expect(outcome.stamp).toBe(StampTier.FAKE);
    expect(outcome.changed).toBe(true);
  });

  it('strengthens MISLEADING to FAKE on false majority', () => {
    const claims = [makeClaim('False'), makeClaim('False')];
    const outcome = applyCorroboration(claims, StampTier.MISLEADING);
    expect(outcome.stamp).toBe(StampTier.FAKE);
    expect(outcome.changed).toBe(true);
  });

  it('keeps FAKE unchanged when already FAKE', () => {
    const claims = [makeClaim('False'), makeClaim('False')];
    const outcome = applyCorroboration(claims, StampTier.FAKE);
    expect(outcome.stamp).toBe(StampTier.FAKE);
    expect(outcome.changed).toBe(false);
  });

  it('mixed results do not alter the stamp', () => {
    const claims = [makeClaim('Mixed'), makeClaim('Mixed')];
    const outcome = applyCorroboration(claims, StampTier.EXAGGERATED);
    expect(outcome.stamp).toBe(StampTier.EXAGGERATED);
    expect(outcome.changed).toBe(false);
  });

  it('true results never downgrade the stamp', () => {
    const claims = [makeClaim('True'), makeClaim('True')];
    const outcome = applyCorroboration(claims, StampTier.FAKE);
    expect(outcome.stamp).toBe(StampTier.FAKE);
    expect(outcome.changed).toBe(false);
  });

  it('absence of results never changes the stamp', () => {
    const outcome = applyCorroboration([], StampTier.EXAGGERATED);
    expect(outcome.stamp).toBe(StampTier.EXAGGERATED);
    expect(outcome.changed).toBe(false);
    expect(outcome.primaryRating).toBeNull();
    expect(outcome.sourceLines).toEqual([]);
  });

  it('exposes source lines for tooltips', () => {
    const claims = [makeClaim('False', 'Vaccines cause autism', 'Snopes')];
    const outcome = applyCorroboration(claims, StampTier.MISLEADING);
    expect(outcome.sourceLines).toEqual([
      'Snopes — False: Vaccines cause autism',
    ]);
  });
});

describe('formatSourceLines', () => {
  it('caps output at maxLines (default 3)', () => {
    const claims = [
      makeClaim('False', 'claim one', 'Pub A'),
      makeClaim('False', 'claim two', 'Pub B'),
      makeClaim('False', 'claim three', 'Pub C'),
      makeClaim('False', 'claim four', 'Pub D'),
      makeClaim('False', 'claim five', 'Pub E'),
    ];
    const lines = formatSourceLines(claims);
    expect(lines).toHaveLength(3);
  });

  it('truncates long claim text with ellipsis at ~60 chars', () => {
    const longClaim = 'y'.repeat(120);
    const claims = [makeClaim('False', longClaim)];
    const lines = formatSourceLines(claims);
    const line = lines[0]!;
    expect(line.length).toBeLessThanOrEqual(120); // publisher + rating + snippet stays short
    expect(line.endsWith('...')).toBe(true);
    // snippet portion is ~60 chars
    const snippet = line.split(': ').pop()!;
    expect(snippet.length).toBeLessThanOrEqual(61);
  });

  it('formats as "Publisher — rating: snippet"', () => {
    const claims = [makeClaim('False', 'short claim', 'Politifact')];
    const lines = formatSourceLines(claims);
    expect(lines[0]).toBe('Politifact — False: short claim');
  });

  it('returns empty array for no claims', () => {
    expect(formatSourceLines([])).toEqual([]);
  });
});

describe('isStillRelevant', () => {
  it('null outcome is not relevant', () => {
    expect(isStillRelevant(null)).toBe(false);
  });

  it('unchanged outcome is relevant for tooltip refresh', () => {
    const outcome = applyCorroboration([], StampTier.EXAGGERATED);
    expect(isStillRelevant(outcome)).toBe(true);
  });

  it('changed outcome is not relevant (already finalized)', () => {
    const claims = [makeClaim('False'), makeClaim('False')];
    const outcome = applyCorroboration(claims, StampTier.EXAGGERATED);
    expect(isStillRelevant(outcome)).toBe(false);
  });
});
