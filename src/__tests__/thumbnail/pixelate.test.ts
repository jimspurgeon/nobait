import { describe, expect, it } from "vitest";
import {
  GRID_LEVELS,
  buildMosaicPyramid,
  buildWaveState,
  hashSeed,
  paintWave,
  seededRandom,
} from "../../thumbnail/pixelate";
import { advanceFrames } from "../setup";

describe("GRID_LEVELS", () => {
  it("matches the specified subdivision passes (12×7 → 24×14 → 48×28)", () => {
    expect(GRID_LEVELS).toEqual([
      { cols: 12, rows: 7 },
      { cols: 24, rows: 14 },
      { cols: 48, rows: 28 },
    ]);
  });
});

describe("hashSeed / seededRandom", () => {
  it("is deterministic for the same videoId", () => {
    expect(hashSeed("dQw4w9WgXcQ")).toBe(hashSeed("dQw4w9WgXcQ"));
    expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
  });

  it("produces repeatable pseudo-random streams", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(new Set(seqA).size).toBeGreaterThan(1);
  });
});

describe("buildMosaicPyramid", () => {
  it("builds one cell per grid position at each level", () => {
    const src = new Image();
    const pyramid = buildMosaicPyramid(src, 320, 180);
    expect(pyramid.levels).toHaveLength(3);
    for (const [i, level] of pyramid.levels.entries()) {
      expect(level.cols).toBe(GRID_LEVELS[i]!.cols);
      expect(level.rows).toBe(GRID_LEVELS[i]!.rows);
      expect(level.cells).toHaveLength(level.cols * level.rows);
    }
  });

  it("creates canvases of nonzero cell size", () => {
    const src = new Image();
    const pyramid = buildMosaicPyramid(src, 240, 140);
    const base = pyramid.levels[0]!;
    for (const cell of base.cells) {
      expect(cell.width).toBeGreaterThan(0);
      expect(cell.height).toBeGreaterThan(0);
    }
  });
});

describe("buildWaveState", () => {
  it("produces thresholds in [0,1] for every cell at every level", () => {
    const wave = buildWaveState(undefined, hashSeed("video-1"));
    expect(wave.thresholds).toHaveLength(3);
    for (const th of wave.thresholds) {
      for (let i = 0; i < th.length; i++) {
        expect(th[i]).toBeGreaterThanOrEqual(0);
        expect(th[i]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is deterministic per seed", () => {
    const a = buildWaveState(undefined, 123);
    const b = buildWaveState(undefined, 123);
    for (const [li, th] of a.thresholds.entries()) {
      expect([...th]).toEqual([...b.thresholds[li]!]);
    }
  });

  it("later levels arrive later on average (sweep ordering)", () => {
    const wave = buildWaveState(undefined, 7);
    const avg = (th: Float32Array) => {
      let s = 0;
      for (let i = 0; i < th.length; i++) s += th[i]!;
      return s / th.length;
    };
    expect(avg(wave.thresholds[0]!)).toBeLessThan(avg(wave.thresholds[1]!));
    expect(avg(wave.thresholds[1]!)).toBeLessThan(avg(wave.thresholds[2]!));
  });

  it("top-left cells of a level arrive before bottom-right ones (wave shape)", () => {
    const wave = buildWaveState(undefined, 7);
    const th = wave.thresholds[1]!; // 24×14
    const tl = th[0]!;
    const br = th[th.length - 1]!;
    expect(tl).toBeLessThan(br);
  });
});

describe("paintWave", () => {
  it("paints only coarse level at p=0 and more cells as p grows", () => {
    const src = new Image();
    const pyramid = buildMosaicPyramid(src, 320, 180);
    const wave = buildWaveState(undefined, 99);

    const draws = { count: 0 };
    const ctx = {
      clearRect: () => {},
      drawImage: () => {
        draws.count++;
      },
      imageSmoothingEnabled: true,
    } as unknown as CanvasRenderingContext2D;

    paintWave(ctx, pyramid, wave, 0);
    const atZero = draws.count;
    // Coarse backdrop only at start.
    expect(atZero).toBe(12 * 7);

    draws.count = 0;
    paintWave(ctx, pyramid, wave, 0.5);
    const atHalf = draws.count;
    expect(atHalf).toBeGreaterThan(atZero);

    draws.count = 0;
    paintWave(ctx, pyramid, wave, 1);
    // Full pyramid painted at completion.
    expect(draws.count).toBe(12 * 7 + 24 * 14 + 48 * 28);
  });
});

describe("advanceFrames helper (setup sanity)", () => {
  it("runs scheduled rAF callbacks", () => {
    let ran = 0;
    requestAnimationFrame(() => ran++);
    advanceFrames(1);
    expect(ran).toBe(1);
  });
});
