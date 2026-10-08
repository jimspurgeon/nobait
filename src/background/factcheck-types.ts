/**
 * StampTier enumeration — duplicated locally from src/stamps/types.ts to avoid
 * circular dependencies in this isolated P6 module. TODO(P6): consolidate with
 * the canonical enum at merge time.
 *
 * Ranking (most severe → least):
 * FAKE > MISLEADING > CLICKBAIT > EXAGGERATED > UNSURE > LEGITIMATE
 */
export enum StampTier {
  FAKE = "fake", // ☠️ dark-red — fabricated premise/debunked
  MISLEADING = "misleading", // ✗ red — title implies something false
  CLICKBAIT = "clickbait", // 🎣 orange — withholding/manufactured curiosity
  EXAGGERATED = "exaggerated", // ⚠ yellow — true but overstated
  UNSURE = "unsure", // ? gray — insufficient signal data
  LEGITIMATE = "legitimate", // ✓ green — accurate, honest, matches content
}

/**
 * Severity rank for comparing stamps numerically.
 */
export function stampRank(tier: StampTier): number {
  switch (tier) {
    case StampTier.FAKE:
      return 6;
    case StampTier.MISLEADING:
      return 5;
    case StampTier.CLICKBAIT:
      return 4;
    case StampTier.EXAGGERATED:
      return 3;
    case StampTier.UNSURE:
      return 2;
    case StampTier.LEGITIMATE:
      return 1;
  }
}
