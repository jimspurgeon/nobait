import { StampTier, VALID_STAMP_TIERS } from '../stamps/types';

/**
 * Strict enum parsing utilities for stamp tier validation
 */

/**
 * Parse a raw string into a StampTier with strict validation.
 * Any malformed value falls back to UNSURE.
 */
export function parseStampTier(raw: unknown): { tier: StampTier; explanation?: string } {
  if (typeof raw !== 'string') {
    return {
      tier: StampTier.UNSURE,
      explanation: 'Stamp was not a string'
    };
  }

  const normalized = raw.trim().toLowerCase();

  if (!VALID_STAMP_TIERS.includes(normalized as StampTier)) {
    return {
      tier: StampTier.UNSURE,
      explanation: `Unknown stamp "${raw}" - defaulted to unsure`
    };
  }

  return { tier: normalized as StampTier };
}

/**
 * Parse a full batch result item with strict validation.
 * Malformed items fall back to UNSURE with explanation, or null if unusable.
 */
export function parseBatchItem(raw: unknown): {
  videoId: string;
  rewrittenTitle: string;
  stamp: StampTier;
  stampExplanation: string;
} | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;

  if (typeof obj.videoId !== 'string' || obj.videoId.length === 0) return null;
  if (typeof obj.rewrittenTitle !== 'string' || obj.rewrittenTitle.length === 0) return null;

  const stampParsed = parseStampTier(obj.stamp);
  const explanation =
    typeof obj.stampExplanation === 'string' && obj.stampExplanation.length > 0
      ? obj.stampExplanation
      : stampParsed.explanation || 'No explanation provided';

  return {
    videoId: obj.videoId,
    rewrittenTitle: obj.rewrittenTitle,
    stamp: stampParsed.tier,
    stampExplanation: explanation
  };
}
