/**
 * Shared types for the thumbnail subsystem.
 */

/** Where inside the video the replacement frame is sampled from. */
export type FramePosition =
  | { kind: 'start' }
  | { kind: 'middle' }
  | { kind: 'end' }
  | { kind: 'random' }
  | { kind: 'percent'; value: number };

/** Full render request: together with the videoId it fully determines the frame. */
export interface ThumbnailConfig {
  position: FramePosition;
}

export const DEFAULT_THUMB_CONFIG: ThumbnailConfig = { position: { kind: 'middle' } };
