/**
 * Badge contrast tests (gatekeeper accessibility finding):
 * white glyph on tier fill must meet WCAG AA (≥4.5:1) for all tiers.
 */

import { describe, it, expect } from "vitest";
import { BADGE_SPECS } from "../../stamps/badges";
import { StampTier } from "../../stamps/types";

/** Relative luminance per WCAG 2.x. */
function luminance(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Contrast ratio between two hex colors. */
function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe("BADGE_SPECS WCAG AA contrast (white glyph on tier fill)", () => {
  for (const tier of Object.values(StampTier)) {
    it(`${tier} fill ${BADGE_SPECS[tier].color} has ≥4.5:1 contrast`, () => {
      const ratio = contrastRatio(BADGE_SPECS[tier].color, "#ffffff");
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("every tier has a distinct glyph (color-blind safety)", () => {
    const glyphs = Object.values(BADGE_SPECS).map((s) => s.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});
