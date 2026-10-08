/**
 * StampTier enum tests — closed-set validation, labels, type guard.
 */

import { describe, test, expect } from "vitest";
import { STAMP_LABELS, STAMP_TIERS, isStampTier } from "../../stamps/types.js";

describe("StampTier", () => {
  test("has exactly the six documented tiers", () => {
    expect(STAMP_TIERS).toEqual([
      "legitimate",
      "exaggerated",
      "misleading",
      "clickbait",
      "fake",
      "unsure",
    ]);
  });

  test("every tier has a human-readable label", () => {
    for (const tier of STAMP_TIERS) {
      expect(STAMP_LABELS[tier].length).toBeGreaterThan(0);
    }
    expect(Object.keys(STAMP_LABELS).length).toBe(6);
  });

  test("isStampTier accepts members and rejects everything else", () => {
    expect(isStampTier("legitimate")).toBe(true);
    expect(isStampTier("unsure")).toBe(true);
    expect(isStampTier("LEGITIMATE")).toBe(false); // case-sensitive by design
    expect(isStampTier("bogus")).toBe(false);
    expect(isStampTier(42)).toBe(false);
    expect(isStampTier(null)).toBe(false);
    expect(isStampTier(undefined)).toBe(false);
  });

  test("STAMP_TIERS is frozen (closed enum discipline)", () => {
    expect(Object.isFrozen(STAMP_TIERS)).toBe(true);
  });
});
