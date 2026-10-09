/**
 * Parses YouTube storyboard specifications.
 *
 * `player_response.storyboards.playerStoryboardSpecRenderer.spec` is a
 * pipe-separated line whose first field is a URL template:
 *
 *   https://i9.ytimg.com/sb/<ID>/storyboard3_L$L/$N.jpg?...&sigh=$sigh$
 *
 * followed by one `#`-separated descriptor per level:
 *
 *   <frameWidth>#<frameHeight>#<intervalMs>#<cols>#<rows>#<?>#<?>#<name>#<sigh>
 *
 * `$L$` substitutes the level index, `$N$` the sheet index encoded as
 * `M<sheet>` (older templates use `$M$` for the bare sheet index), and
 * `$sigh$` the per-level signature.
 *
 * Levels are ordered L0 (tiny mosaic, most sheets) → higher (larger tiles).
 */

export interface StoryboardLevel {
  /** L<N> level — higher means larger tiles / fewer sprite sheets. */
  level: number;
  /** Base URL template containing `$L$`, `$N$`/`$M$` and `$sigh$`. */
  baseUrl: string;
  /** Columns in every sprite sheet of this level. */
  columns: number;
  /** Rows in every sprite sheet of this level. */
  rows: number;
  /** Frames held by one sprite sheet (columns × rows). */
  framesPerSheet: number;
  /** Storyboard sampling interval (ms per frame). */
  intervalMs: number;
  /** Width of a single frame (px). */
  width: number;
  /** Height of a single frame (px). */
  height: number;
  /** Per-level signature for the URL template, when present. */
  sigh: string | null;
  /**
   * Total frames covered by the storyboard — `ceil(duration / interval)`
   * when the video duration is known; otherwise conservatively
   * `framesPerSheet`.
   */
  totalFrames: number;
}

export interface PlayerStoryboardSpec {
  levels: StoryboardLevel[];
  durationMs: number;
}

function toNum(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Parse the pipe-separated spec line. `videoDurationMs` (from
 * `videoDetails.lengthSeconds`) turns interval-based levels into absolute
 * frame counts; without it we fall back to one-sheet totals, which still
 * yields valid (if coarse) positions.
 */
export function parseSpecString(
  spec: string,
  videoDurationMs = 0,
): PlayerStoryboardSpec {
  const parts = spec.split("|");
  if (parts.length < 2)
    throw new Error("nobait/storyboard: malformed spec (too few fields)");

  const baseUrl = parts[0]!;
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error("nobait/storyboard: spec URL template missing");
  }

  const levels: StoryboardLevel[] = [];
  for (let i = 1; i < parts.length; i++) {
    const f = parts[i]!.split("#");
    if (f.length < 5) continue;

    const width = toNum(f[0]);
    const height = toNum(f[1]);
    const intervalMs = toNum(f[2]);
    const columns = toNum(f[3]);
    const rows = toNum(f[4]);
    // Field layout evolved over the years; `sigh` has lived at index 6,
    // 7, and 8 depending on era. Scan the tail fields for the first
    // non-empty string that looks like a signature (not numeric, not
    // "default"/"M$M" placeholders).
    let sigh: string | null = null;
    for (let k = f.length - 1; k >= 5; k--) {
      const v = f[k];
      if (
        v &&
        v !== "default" &&
        v !== "M$M" &&
        !/^\d+$/.test(v)
      ) {
        sigh = v;
        break;
      }
    }
    if (!(width > 0 && height > 0 && intervalMs > 0 && columns > 0 && rows > 0))
      continue;

    const framesPerSheet = columns * rows;
    const totalFrames =
      videoDurationMs > 0
        ? Math.max(1, Math.ceil(videoDurationMs / intervalMs))
        : framesPerSheet;

    levels.push({
      level: i - 1,
      baseUrl,
      columns,
      rows,
      framesPerSheet,
      intervalMs,
      width,
      height,
      sigh,
      totalFrames,
    });
  }

  if (levels.length === 0) {
    throw new Error("nobait/storyboard: no usable levels in spec");
  }
  return { levels, durationMs: videoDurationMs };
}

/** Convert a URL template to a fetchable sheet URL. */
export function buildSheetUrl(level: StoryboardLevel, sheet: number): string {
  // Placeholder formats in the wild, newest first:
  //   storyboard3_L$L/$N.jpg   (modern: no trailing $ on placeholders)
  //   storyboard3_L$L/$N$.jpg (legacy: $L$ / $N$ / $M$)
  // Replace legacy forms first so "$L$" is consumed before "$L".
  let url = level.baseUrl
    .replace(/\$L\$/g, String(level.level))
    .replace(/\$N\$/g, `M${sheet}`)
    .replace(/\$M\$/g, String(sheet))
    .replace(/\$sigh\$/g, level.sigh ?? "")
    .replace(/\$L/g, String(level.level))
    .replace(/\$N/g, `M${sheet}`);
  // Modern specs carry the signature only in the level descriptor — the
  // base URL query has `sqp=` but no `sigh`. Append it when missing.
  if (level.sigh && !/[?&]sigh=/.test(url)) {
    url += (url.includes("?") ? "&" : "?") + "sigh=" + encodeURIComponent(level.sigh);
  }
  return url;
}

interface RawPlayerResponse {
  storyboards?: {
    playerStoryboardSpecRenderer?: { spec?: string };
    playerLiveStoryboardSpecRenderer?: { spec?: string };
  };
  videoDetails?: { lengthSeconds?: string | number };
}

function isValidLevel(l: unknown): l is StoryboardLevel {
  if (!l || typeof l !== "object") return false;
  const v = l as Record<string, unknown>;
  return (
    typeof v.baseUrl === "string" &&
    typeof v.columns === "number" &&
    typeof v.rows === "number" &&
    typeof v.framesPerSheet === "number" &&
    typeof v.width === "number" &&
    typeof v.height === "number" &&
    typeof v.totalFrames === "number"
  );
}

/**
 * Accept anything reasonable and normalize to a PlayerStoryboardSpec.
 * Handles: our own cached normalized spec (round-trips through IndexedDB),
 * a raw `player_response` object, or a raw spec string. Returns null when
 * nothing parseable is found — callers degrade gracefully.
 */
export function parseStoryboardSpec(
  input: unknown,
): PlayerStoryboardSpec | null {
  if (!input) return null;
  if (typeof input === "string") {
    try {
      return parseSpecString(input);
    } catch {
      return null;
    }
  }
  if (typeof input !== "object") return null;

  const obj = input as Record<string, unknown>;

  // Already-normalized spec.
  if (Array.isArray(obj.levels) && obj.levels.length > 0) {
    const levels = obj.levels as unknown[];
    if (levels.every(isValidLevel)) {
      return {
        levels: levels as StoryboardLevel[],
        durationMs:
          typeof obj.durationMs === "number"
            ? obj.durationMs
            : (levels[0] as StoryboardLevel).totalFrames > 0
              ? (levels[0] as StoryboardLevel).intervalMs *
                (levels[0] as StoryboardLevel).totalFrames
              : 0,
      };
    }
    return null;
  }

  // Raw player_response shape.
  const raw = obj as RawPlayerResponse;
  if (raw.storyboards) {
    const specStr =
      raw.storyboards.playerStoryboardSpecRenderer?.spec ??
      raw.storyboards.playerLiveStoryboardSpecRenderer?.spec;
    const lengthSec = Number(raw.videoDetails?.lengthSeconds ?? 0);
    const durationMs =
      Number.isFinite(lengthSec) && lengthSec > 0 ? lengthSec * 1000 : 0;
    if (typeof specStr === "string") {
      try {
        return parseSpecString(specStr, durationMs);
      } catch {
        return null;
      }
    }
    return null;
  }

  return null;
}

/**
 * Extract the storyboard spec for one video from raw `player_response`
 * JSON (fetched from the InnerTube API by the caller).
 */
export function specFromPlayerResponse(
  playerResponse: unknown,
): PlayerStoryboardSpec | null {
  return parseStoryboardSpec(playerResponse);
}

/**
 * Pick the level whose frames are just big enough for `minWidth` (sprite
 * files grow quadratically with level). Falls back to the largest level
 * when none is wide enough.
 */
export function selectLevel(
  spec: PlayerStoryboardSpec,
  minWidth: number,
): StoryboardLevel {
  let best: StoryboardLevel | null = null;
  for (const l of spec.levels) {
    if (l.width >= minWidth && (!best || l.width < best.width)) best = l;
  }
  if (!best) {
    best =
      [...spec.levels].sort(
        (a, b) => b.width * b.height - a.width * a.height,
      )[0] ?? null;
  }
  if (!best) {
    throw new Error("nobait/storyboard: spec contains no levels");
  }
  return best;
}
