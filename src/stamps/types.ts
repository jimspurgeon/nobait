/**
 * Credibility stamp tiers.
 *
 * This is a CLOSED enum — never free-form. Every classification produced by
 * an AI provider must map onto exactly one of these six tiers; any output
 * that cannot be mapped deterministically falls back to {@link StampTier.UNSURE}.
 *
 * Each tier is rendered with a distinct glyph + color pair (see
 * `src/stamps/badges.ts`). Glyphs differ by shape alone so tiers remain
 * distinguishable for color-blind users.
 */
export enum StampTier {
  /** ✓ green — accurate, honest, matches the content. */
  LEGITIMATE = "legitimate",
  /** ⚠ yellow — true but overstated / sensationalized. */
  EXAGGERATED = "exaggerated",
  /** ✗ red — title implies something the content does not deliver. */
  MISLEADING = "misleading",
  /** 🎣 orange — withholding, manufactured curiosity. */
  CLICKBAIT = "clickbait",
  /** ☠️ dark red — fabricated premise or debunked claim. */
  FAKE = "fake",
  /** ? gray — insufficient signal data to judge. */
  UNSURE = "unsure",
}

/** All valid tiers, in display order. Useful for iteration and validation. */
export const STAMP_TIERS: readonly StampTier[] = Object.freeze([
  StampTier.LEGITIMATE,
  StampTier.EXAGGERATED,
  StampTier.MISLEADING,
  StampTier.CLICKBAIT,
  StampTier.FAKE,
  StampTier.UNSURE,
]);

/** Human-readable label for each tier (used in tooltips/UI). */
export const STAMP_LABELS: Readonly<Record<StampTier, string>> = Object.freeze({
  [StampTier.LEGITIMATE]: "Legitimate",
  [StampTier.EXAGGERATED]: "Exaggerated",
  [StampTier.MISLEADING]: "Misleading",
  [StampTier.CLICKBAIT]: "Clickbait",
  [StampTier.FAKE]: "Fake",
  [StampTier.UNSURE]: "Unsure",
});

/**
 * Returns true iff `value` is a member of the {@link StampTier} enum.
 * Used by the strict response parser — anything else maps to UNSURE.
 */
export function isStampTier(value: unknown): value is StampTier {
  return (
    typeof value === "string" &&
    (STAMP_TIERS as readonly string[]).includes(value)
  );
}

/**
 * Valid stamp tier values for runtime validation (compat alias for STAMP_TIERS).
 */
export const VALID_STAMP_TIERS: readonly StampTier[] = STAMP_TIERS;

/**
 * AI provider input data (the enriched signal set per video).
 */
export interface AIInput {
  videoId: string;
  title: string;
  description?: string;
  transcript?: string;
  chapters?: Array<{ startMs: number; title: string }>;
  viewCount?: number;
}

/**
 * Stamp result from AI analysis.
 */
export interface StampResult {
  videoId: string;
  rewrittenTitle: string;
  stamp: StampTier;
  stampExplanation: string; // 1-2 sentences
  timestamp: number;
  modelVersion: string;
}

/**
 * Negative cache entry for videos that couldn't be analyzed.
 */
export interface NegativeCacheEntry {
  videoId: string;
  reason: "no_transcript" | "too_short" | "unavailable" | "error";
  timestamp: number;
  ttlMs: number; // Shorter TTL than positive cache
}

/**
 * Cache entry structure.
 */
export interface CacheEntry {
  videoId: string;
  result: StampResult;
  inputHash: string; // Hash of title+description+transcript for invalidation
  modelVersion: string;
  createdAt: number;
  expiresAt: number;
}
