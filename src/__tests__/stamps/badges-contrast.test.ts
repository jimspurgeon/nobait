/**
 * WCAG AA contrast verification for stamp badge colors.
 *
 * Checks two requirements against both YouTube light (white) and dark
 * (#0f0f0f) themes:
 *  1. White glyph on the badge fill ≥ 4.5:1 (the glyph is text-like).
 *  2. Badge fill vs the page background ≥ 3:1 (non-text contrast, WCAG 1.4.11).
 *
 * Also asserts glyphs are pairwise distinct (color-blind safety: shape,
 * not color, carries the meaning).
 */

import { describe, test, expect } from "vitest";
import { BADGE_SPECS } from "../../stamps/badges.js";
import { STAMP_TIERS } from "../../stamps/types.js";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = hexToRgb(hex);
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** YouTube theme backgrounds the badges render against. */
const BACKGROUNDS: Record<string, string> = {
  light: "#ffffff",
  dark: "#0f0f0f",
};

describe("badge WCAG AA contrast", () => {
  for (const tier of STAMP_TIERS) {
    const spec = BADGE_SPECS[tier];

    test(`${tier}: white glyph on fill ≥ 4.5:1 (AA text)`, () => {
      expect(contrastRatio("#ffffff", spec.color)).toBeGreaterThanOrEqual(4.5);
    });

    for (const [theme, bg] of Object.entries(BACKGROUNDS)) {
      test(`${tier}: fill vs ${theme} background ≥ 3:1 (AA non-text)`, () => {
        expect(contrastRatio(spec.color, bg)).toBeGreaterThanOrEqual(3);
      });
    }

    test(`${tier}: has a non-empty label`, () => {
      expect(spec.label.length).toBeGreaterThan(0);
    });
  }

  test("glyphs are pairwise distinct (color-blind safe)", () => {
    const glyphs = STAMP_TIERS.map((t) => BADGE_SPECS[t].glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  test("badge colors are pairwise distinct", () => {
    const colors = STAMP_TIERS.map((t) => BADGE_SPECS[t].color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});
