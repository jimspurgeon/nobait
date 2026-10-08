/**
 * Offscreen/hidden-canvas compositor: given a fetched sprite sheet image
 * and tile coordinates, crop the tile on a canvas and produce a blob URL.
 *
 * Runs identically in the content script and the background service
 * worker (OffscreenCanvas + createImageBitmap cover both; we don't rely
 * on document.createElement).
 */

import type { StoryboardLevel } from './storyboard';
import type { TileRect } from './frame';

/** Crops the tile at `rect` out of `bitmap` and returns a Blob. */
export async function cropTile(bitmap: ImageBitmap, _level: StoryboardLevel, rect: TileRect): Promise<Blob | null> {
  const w = Math.min(rect.sw, bitmap.width - rect.sx);
  const h = Math.min(rect.sh, bitmap.height - rect.sy);
  if (w <= 0 || h <= 0) return null;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, rect.sx, rect.sy, w, h, 0, 0, w, h);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
}

/** Convenience: crop and wrap in an object URL in one step. */
export async function composeFrame(
  spriteUrl: string,
  level: StoryboardLevel,
  rect: TileRect,
  fetchImpl: typeof fetch = fetch.bind(globalThis)
): Promise<string> {
  const resp = await fetchImpl(spriteUrl, { credentials: 'omit' });
  if (!resp.ok) {
    throw new Error(`nobait/render: sprite fetch failed (${resp.status})`);
  }
  const buf = await resp.arrayBuffer();
  const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
  try {
    const blob = await cropTile(bitmap, level, rect);
    if (!blob) throw new Error('nobait/render: tile outside sprite bounds');
    return URL.createObjectURL(blob);
  } finally {
    bitmap.close();
  }
}
