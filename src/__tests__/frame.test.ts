import { describe, test, expect } from "vitest";
import {
  hashSeed,
  prng,
  selectTile,
  sheetFor,
  tileFor,
  totalFrames,
} from "../thumbnail/frame";
import type { StoryboardLevel } from "../thumbnail/storyboard";

const makeLevel = (over: Partial<StoryboardLevel> = {}): StoryboardLevel => ({
  level: 0,
  baseUrl: "https://example.com/$L$/$N$.jpg",
  columns: 2,
  rows: 2,
  framesPerSheet: 4,
  intervalMs: 5000,
  width: 80,
  height: 45,
  sigh: null,
  totalFrames: 100,
  ...over,
});

describe("hashSeed / prng", () => {
  test("hashSeed is deterministic and distinguishing", () => {
    expect(hashSeed("dQw4w9WgXcQ")).toBe(hashSeed("dQw4w9WgXcQ"));
    expect(hashSeed("abc")).not.toBe(hashSeed("xyz"));
  });

  test("prng seeded with hashSeed yields reproducible sequences", () => {
    const rngA = prng(hashSeed("test123"));
    const a = [rngA(), rngA(), rngA()];
    const rngB = prng(hashSeed("test123"));
    const b = [rngB(), rngB(), rngB()];
    expect(a).toEqual(b);
    expect(a.every((v) => v >= 0 && v < 1)).toBe(true);
  });
});

describe("totalFrames", () => {
  test("uses configured total", () => {
    expect(totalFrames(makeLevel({ totalFrames: 1000 }))).toBe(1000);
  });

  test("clamps to at least 1", () => {
    expect(totalFrames(makeLevel({ totalFrames: 0 }))).toBe(1);
  });
});

describe("sheetFor / tileFor", () => {
  test("frame indices map to correct sheets", () => {
    const level = makeLevel({ framesPerSheet: 4 });
    expect(sheetFor(level, 0)).toBe(0);
    expect(sheetFor(level, 3)).toBe(0);
    expect(sheetFor(level, 4)).toBe(1);
    expect(sheetFor(level, 99)).toBe(24);
  });

  test("tiles flow row-major with correct pixel rects", () => {
    const level = makeLevel({ columns: 2, rows: 2, width: 80, height: 45 });
    // frame 5 → sheet 1, in-sheet index 1 → row 0, col 1
    const { sheet, rect } = tileFor(level, 5);
    expect(sheet).toBe(1);
    expect(rect).toEqual({ sx: 80, sy: 0, sw: 80, sh: 45 });
    // frame 6 → sheet 1, in-sheet index 2 → row 1, col 0
    const t6 = tileFor(level, 6);
    expect(t6.sheet).toBe(1);
    expect(t6.rect).toEqual({ sx: 0, sy: 45, sw: 80, sh: 45 });
  });
});

describe("selectTile positions", () => {
  test("middle position hits ~50th frame of 100", () => {
    const level = makeLevel({ totalFrames: 100 });
    // Math.round rounds half up: round(0.5 * 99) = 50.
    expect(selectTile("vid1", { kind: "middle" }, level).frameIndex).toBe(50);
  });

  test("start position hits ~10%", () => {
    const level = makeLevel({ totalFrames: 100 });
    const idx = selectTile("vid1", { kind: "start" }, level).frameIndex;
    expect(idx).toBeLessThanOrEqual(12);
    expect(idx).toBeGreaterThanOrEqual(8);
  });

  test("end position hits ~90%", () => {
    const level = makeLevel({ totalFrames: 100 });
    const idx = selectTile("vid1", { kind: "end" }, level).frameIndex;
    expect(idx).toBeGreaterThanOrEqual(87);
  });

  test("random position is deterministic per videoId and varies across videos", () => {
    const level = makeLevel({ totalFrames: 100 });
    const r1 = selectTile("video1", { kind: "random" }, level).frameIndex;
    const r2 = selectTile("video1", { kind: "random" }, level).frameIndex;
    expect(r1).toBe(r2);
    // Across a population of ids, random positions spread out.
    const picks = new Set(
      Array.from(
        { length: 50 },
        (_, i) => selectTile(`v${i}`, { kind: "random" }, level).frameIndex,
      ),
    );
    expect(picks.size).toBeGreaterThan(10);
  });

  test("random stays inside middle band (no intro/outro slates)", () => {
    const level = makeLevel({ totalFrames: 100 });
    for (let i = 0; i < 100; i++) {
      const idx = selectTile(`vid${i}`, { kind: "random" }, level).frameIndex;
      expect(idx).toBeGreaterThanOrEqual(10);
      expect(idx).toBeLessThanOrEqual(90);
    }
  });

  test("percent position resolves proportionally", () => {
    const level = makeLevel({ totalFrames: 101 });
    expect(
      selectTile("x", { kind: "percent", value: 0 }, level).frameIndex,
    ).toBe(0);
    expect(
      selectTile("x", { kind: "percent", value: 0.5 }, level).frameIndex,
    ).toBe(50);
    expect(
      selectTile("x", { kind: "percent", value: 1 }, level).frameIndex,
    ).toBe(100);
  });

  test("percent clamps out-of-range values", () => {
    const level = makeLevel({ totalFrames: 100 });
    expect(
      selectTile("x", { kind: "percent", value: -1 }, level).frameIndex,
    ).toBe(0);
    expect(
      selectTile("x", { kind: "percent", value: 100 }, level).frameIndex,
    ).toBe(99);
  });

  test("determinism: same videoId + config + level → same tile forever", () => {
    const level = makeLevel({
      totalFrames: 1000,
      columns: 5,
      rows: 5,
      framesPerSheet: 25,
      width: 160,
      height: 90,
    });
    const a = selectTile("dQw4w9WgXcQ", { kind: "middle" }, level);
    const b = selectTile("dQw4w9WgXcQ", { kind: "middle" }, level);
    expect(a).toEqual(b);
    expect(a.rect.sw).toBe(160);
  });

  test("same frame across differently-seeded managers (regression): consistent via stable hash", () => {
    const level = makeLevel({ totalFrames: 50 });
    const all: number[] = [];
    for (let i = 0; i < 3; i++) {
      all.push(selectTile("stable", { kind: "random" }, level).frameIndex);
    }
    expect(new Set(all).size).toBe(1);
  });
});
