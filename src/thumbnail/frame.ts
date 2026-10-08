/**
 * Deterministic frame-position math — placeholder for P2. Given a videoId
 * seed and config (start/middle/end/random), computes the sprite tile and
 * pixel crop rect.
 */

export type FramePosition = "start" | "middle" | "end" | "random";

export function pickFrameIndex(
  videoId: string,
  totalFrames: number,
  pos: FramePosition,
): number {
  // TODO(P2): seeded deterministic selection.
  void videoId;
  void pos;
  return Math.max(0, totalFrames - 1);
}
