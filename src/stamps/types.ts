/**
 * Credibility stamp tiers — a closed enum, never free-form.
 *
 * The stamp applies to the video's ORIGINAL framing (title/thumbnail),
 * not to the rewritten title.
 */
export enum StampTier {
  LEGITIMATE = "legitimate", // ✓ green     — accurate, honest, matches content
  EXAGGERATED = "exaggerated", // ⚠ yellow  — true but overstated/sensationalized
  MISLEADING = "misleading", // ✗ red       — title implies something false
  CLICKBAIT = "clickbait", // 🎣 orange     — withholding, manufactured curiosity
  FAKE = "fake", // ☠️ dark red             — fabricated premise/debunked
  UNSURE = "unsure", // ? gray              — insufficient signal data
}

export interface StampResult {
  tier: StampTier;
  /** 1–2 sentences: why this rating. Shown in the hover tooltip. */
  explanation: string;
}
