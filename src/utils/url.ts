/**
 * Extracts the 11-character YouTube video ID from any known URL shape.
 *
 * Handles watch URLs, shorts, embeds, live, youtu.be links, and bare IDs.
 * Returns null when the string is not a recognizable video reference —
 * callers must treat null as "not a video" rather than an error.
 */
const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

const PATH_PATTERNS: RegExp[] = [
  /\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})/, // watch?v=... (&v= anywhere)
  /\/shorts\/([a-zA-Z0-9_-]{11})/,
  /\/embed\/([a-zA-Z0-9_-]{11})/,
  /\/live\/([a-zA-Z0-9_-]{11})/,
  /^\/([a-zA-Z0-9_-]{11})$/,
];

export function extractVideoId(
  urlLike: string | URL | null | undefined,
): string | null {
  if (!urlLike) return null;
  try {
    const url =
      typeof urlLike === "string"
        ? new URL(urlLike, "https://youtube.com")
        : urlLike;
    if (
      !/(^|\.)youtube\.com$/.test(url.hostname) &&
      !/(^|\.)youtu\.be$/.test(url.hostname)
    ) {
      return null;
    }
    // youtu.be/<id> short links carry the ID as the pathname.
    if (
      /(^|\.)youtu\.be$/.test(url.hostname) &&
      VIDEO_ID.test(url.pathname.slice(1))
    ) {
      return url.pathname.slice(1);
    }
    const v = url.searchParams.get("v");
    if (v && VIDEO_ID.test(v)) return v;
    for (const pattern of PATH_PATTERNS) {
      const m = url.pathname.match(pattern);
      if (m?.[1] && VIDEO_ID.test(m[1])) return m[1];
    }
    return null;
  } catch {
    return VIDEO_ID.test(String(urlLike)) ? String(urlLike) : null;
  }
}

/** True when the hostname belongs to YouTube (www, m, music, …). */
export function isYouTubeHost(hostname: string): boolean {
  return /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(hostname);
}
