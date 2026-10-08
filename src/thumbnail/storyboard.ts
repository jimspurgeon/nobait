/**
 * YouTube storyboard spec parser
 * Extracts actual frames from YouTube's sprite sheets
 */

export interface StoryboardSpec {
  urlTemplate: string;
  width: number;
  height: number;
  tileCount: number;
  framesPerTile: number;
  totalFrames: number;
  sig: string;
}

export interface FramePosition {
  videoId: string;
  timestampMs: number;
  /** Computed frame index within the storyboard */
  frameIndex?: number;
}

/**
 * Parse storyboard spec from player_response.storyboards
 */
export function parseStoryboardSpec(data: unknown): StoryboardSpec | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const arrays = obj.storyboards as any[] | undefined;
  if (!arrays || arrays.length === 0) return null;

  const first = arrays[0];
  if (typeof first !== 'object') return null;
  const spec = first as Record<string, unknown>;

  const urlTemplate = spec.storyboard_URL_template as string;
  const width = spec.width as number;
  const height = spec.height as number;
  const tileCount = spec.tile_count as number;
  const frameCount = spec.frame_count as number;

  if (!urlTemplate || !width || !height) return null;

  return {
    urlTemplate: urlTemplate.replace('$W', String(width)).replace('$H', String(height)),
    width,
    height,
    tileCount,
    framesPerTile: Math.floor(frameCount / tileCount),
    totalFrames: frameCount,
    sig: extractSignature(urlTemplate)
  };
}

/**
 * Extract signature from storyboard URL template
 */
function extractSignature(template: string): string {
  const match = template.match(/[?&]sigh=([^&]+)/);
  return match?.[1] ?? '';
}

/**
 * Calculate which sprite tile contains a given timestamp
 */
export function calculateFrame(spec: StoryboardSpec, timestampMs: number): FramePosition {
  const { frameIndex } = calculateIndices(spec, timestampMs);
  const durationMs = (spec.totalFrames / 30) * 1000;
  const clampedTimestamp = Math.max(0, Math.min(timestampMs, durationMs));

  return {
    videoId: '',
    timestampMs: Math.floor(clampedTimestamp),
    frameIndex
  } as FramePosition;
}

/**
 * Fetch and crop a frame from storyboard sprite.
 * Deterministic given (spec, timestampMs): the same inputs always produce
 * the same frame, so the same thumbnail appears consistently across sessions.
 */
export async function fetchFrame(spec: StoryboardSpec, timestampMs: number): Promise<Blob | null> {
  const { frameIndex } = calculateIndices(spec, timestampMs);
  const tileIndex = Math.floor(frameIndex / spec.framesPerTile);
  const frameInTile = frameIndex % spec.framesPerTile;

  const url = spec.urlTemplate
    .replace('<L>', `L${tileIndex}`)
    .replace('<M>', String(tileIndex))
    .replace('&sigh=<SIG>', `&sigh=${spec.sig}`);

  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const blob = await response.blob();
    return await cropFrame(blob, spec, frameInTile);
  } catch {
    return null;
  }
}

/**
 * Compute frame + tile indices for a timestamp
 */
function calculateIndices(spec: StoryboardSpec, timestampMs: number): { frameIndex: number } {
  const durationMs = (spec.totalFrames / 30) * 1000; // ~30fps storyboards
  const clamped = Math.max(0, Math.min(timestampMs, durationMs));
  const frameIndex = Math.floor((clamped / durationMs) * spec.totalFrames);
  return { frameIndex };
}

/**
 * Crop a single frame from a sprite sheet
 */
function cropFrame(spriteBlob: Blob, spec: StoryboardSpec, frameIndex: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(spriteBlob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = spec.width;
      canvas.height = spec.height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Cannot get canvas context'));
        return;
      }

      const cols = 5; // Typically 5 tiles per row
      const tileWidth = spec.width;
      const tileHeight = spec.height;
      const x = (frameIndex % cols) * tileWidth;
      const y = Math.floor(frameIndex / cols) * tileHeight;

      ctx.drawImage(img, x, y, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight);
      URL.revokeObjectURL(url);

      canvas.toBlob((blob) => {
        resolve(blob || new Blob());
      }, 'image/jpeg', 0.8);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load sprite image'));
    };
    img.src = url;
  });
}
