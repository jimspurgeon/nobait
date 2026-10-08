import { StampTier } from "./factcheck-types.js";
import { classifyRating } from "./factcheck-client.js";
import type { FactCheckClaim, RatingCategory } from "./factcheck-client.js";

/**
 * Corroboration semantics: map claim-review ratings into stamp influence.
 *
 * Rules (from PLAN.md §3 Stage 4 + task spec):
 * - Corroborated FALSE → strengthens FAKE (upgrades from softer tiers).
 * - Mixed / unclassified / true → no change (conservative).
 * - NEVER downgrade to a softer tier purely from absence of results: no
 *   results ⇒ no suggestion at all.
 */

/**
 * Outcome of evaluating fact-check results against a video's current stamp.
 */
export interface CorroborationOutcome {
  /** Adjusted stamp; SAME as input when results don't warrant a change. */
  stamp: StampTier;
  /** Whether the stamp was strengthened by corroboration. */
  changed: boolean;
  /** Dominant rating category across reviews (null when no reviews). */
  primaryRating: RatingCategory | null;
  /** Short human-readable source lines for the stamp tooltip. */
  sourceLines: string[];
}

/**
 * Derive the dominant rating category across claim reviews.
 *
 * Only a majority of FALSE counts as corroboration of fakery. Everything
 * else collapses to 'mixed' — informative for the tooltip but never
 * sufficient to alter the stamp. Null when there are no reviews at all.
 */
export function dominantRating(
  claims: FactCheckClaim[],
): RatingCategory | null {
  if (claims.length === 0) return null;

  let falseCount = 0;
  let trueCount = 0;
  for (const claim of claims) {
    const cat = classifyRating(claim.textualRating);
    if (cat === "false") falseCount++;
    else if (cat === "true") trueCount++;
  }

  // STRICT majority required for 'false': a 50/50 split must not
  // corroborate fakery (conservative corroboration semantics).
  if (claims.length > 0 && falseCount > claims.length / 2) return "false";
  if (trueCount > claims.length / 2) return "true";
  return "mixed";
}

/**
 * Apply corroboration semantics to a current stamp.
 *
 * - dominant 'false' + not already FAKE → FAKE (strengthen).
 * - anything else (including no results) → unchanged stamp.
 */
export function applyCorroboration(
  claims: FactCheckClaim[],
  currentStamp: StampTier,
): CorroborationOutcome {
  const primaryRating = dominantRating(claims);

  let stamp = currentStamp;
  let changed = false;

  if (primaryRating === "false" && currentStamp !== StampTier.FAKE) {
    // Corroborated falsehood → strengthen to FAKE.
    stamp = StampTier.FAKE;
    changed = true;
  }

  return {
    stamp,
    changed,
    primaryRating,
    sourceLines: formatSourceLines(claims),
  };
}

/**
 * Produce short human-readable tooltip lines, one per review.
 *
 * Format: "Publisher — rating: truncated claim"
 */
export function formatSourceLines(
  claims: FactCheckClaim[],
  maxLines = 3,
): string[] {
  const lines: string[] = [];
  for (const claim of claims.slice(0, maxLines)) {
    const claimSnippet =
      claim.claimText.length > 60
        ? `${claim.claimText.slice(0, 57)}...`
        : claim.claimText;
    lines.push(`${claim.publisher} — ${claim.textualRating}: ${claimSnippet}`);
  }
  return lines;
}

/**
 * Convenience: is a late-arriving result still relevant?
 *
 * A late fact-check result may only refresh the tooltip; it may not reopen
 * or re-gate the swap. Here, relevance means an earlier result had not
 * already finalized a stamp change (a changed stamp would supersede).
 */
export function isStillRelevant(
  previousOutcome: CorroborationOutcome | null,
): boolean {
  return previousOutcome != null && !previousOutcome.changed;
}
