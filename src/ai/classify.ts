/**
 * Credibility classification prompt + strict parsing — placeholder for P3.
 * Must output exactly one StampTier plus a one-sentence explanation; any
 * ambiguity falls back to UNSURE.
 */

import { StampTier } from "../stamps/types";

export function parseStampResponse(raw: string): {
  tier: StampTier;
  explanation: string;
} {
  // Strict: exact enum match or UNSURE.
  const m = raw
    .trim()
    .match(/^(legitimate|exaggerated|misleading|clickbait|fake|unsure)\b/i);
  const matched = m?.[0];
  const tier = matched
    ? (matched.toLowerCase() as StampTier)
    : StampTier.UNSURE;
  const explanation = matched ? raw.trim().slice(matched.length).trim() : "";
  return { tier, explanation };
}
