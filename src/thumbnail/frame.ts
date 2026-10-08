/**
 * Deterministic frame math for storyboard sprites.
 *
 * Given (videoId, position-config, level) the output is always identical:
 * randomness is drawn from an FNV-1a hash of the videoId (seeded PRNG),
 * never from Math.random().
 */

import type { StoryboardLevel } from "./storyboard";
import type { FramePosition } from "./types";

/** FNV-1a 32-bit hash → unsigned int seed. */
export function hashSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG. Returns [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Total number of frames covered by this level's storyboard. When the
 * video duration is unknown this falls back to a single sheet's worth —
 * positions still resolve deterministically, just within the first sheet.
 */
export function totalFrames(level: StoryboardLevel): number {
  return Math.max(1, level.totalFrames);
}

/** Index of the sprite sheet holding `frameIndex` (0-based). */
export function sheetFor(level: StoryboardLevel, frameIndex: number): number {
  return Math.floor(frameIndex / level.framesPerSheet);
}

/**
 * Translate the configured position into a concrete 0-based frame index.
 *
 * Percent `value` may exceed 1 (clamped to 0..1). `start` ≈ 10% in (skip
 * fade-in black frames), `end` ≈ 90% out, `middle` = 50%, `random` draws
 * deterministically from the middle 80% band (skip intro/outro slates).
 */
export function frameIndexForPosition(
  videoId: string,
  position: FramePosition,
  level: StoryboardLevel,
): number {
  const total = totalFrames(level);
  const frac = positionFraction(videoId, position);
  return clamp(Math.round(frac * (total - 1)), 0, total - 1);
}

function positionFraction(videoId: string, position: FramePosition): number {
  switch (position.kind) {
    case "start":
      return 0.1;
    case "middle":
      return 0.5;
    case "end":
      return 0.9;
    case "random": {
      const rand = prng(hashSeed(`${videoId}:frame`))();
      // Middle 80% band [0.1, 0.9).
      return 0.1 + rand * 0.8;
    }
    case "percent": {
      const p = Number(position.value);
      return Number.isFinite(p) ? clamp(p, 0, 1) : 0.5;
    }
    default:
      return 0.5;
  }
}

const clamp = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n;

export interface TileRect {
  /** px in the sprite sheet of the x,y origin of the tile. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Pixel rect of the tile containing `frameIndex` inside its sprite sheet.
 * Tiles flow row-major: frame k sits at row floor(k / columns), column
 * k mod columns, except on the *last* sheet where remaining frames hug
 * the top-left (they're left-packed).
 */
export function tileFor(
  level: StoryboardLevel,
  frameIndex: number,
): { sheet: number; rect: TileRect } {
  const sheet = sheetFor(level, frameIndex);
  const idxInSheet = frameIndex - sheet * level.framesPerSheet;
  const col = idxInSheet % level.columns;
  const row = Math.floor(idxInSheet / level.columns);
  return {
    sheet,
    rect: {
      sx: col * level.width,
      sy: row * level.height,
      sw: level.width,
      sh: level.height,
    },
  };
}

/**
 * One-stop helper: pick the frame for (videoId, config) on `level` and
 * return the sheet index plus pixel rect to crop.
 */
export function selectTile(
  videoId: string,
  position: FramePosition,
  level: StoryboardLevel,
): { frameIndex: number; sheet: number; rect: TileRect } {
  const frameIndex = frameIndexForPosition(videoId, position, level);
  const { sheet, rect } = tileFor(level, frameIndex);
  return { frameIndex, sheet, rect };
}
