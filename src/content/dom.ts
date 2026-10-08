import { extractVideoId } from "../utils/url";

/**
 * Central registry of YouTube DOM selectors.
 *
 * If YouTube changes markup, this is the only file to update.
 */
export const SELECTORS = {
  /** Links to watch pages — the most reliable video-ID carrier anywhere. */
  WATCH_LINK: 'a[href*="/watch?v="][href]',

  /** Compact grid/list cards (home, search results, sidebar). */
  VIDEO_RENDERER:
    "ytd-video-renderer, ytd-rich-grid-media, ytd-compact-video-renderer, ytd-grid-video-renderer",

  /** Currently-playing video element (watch page). */
  PLAYER: "#movie_player video, video.html5-main-video",

  /** Canonical anchor on watch pages. */
  CANONICAL: 'link[rel="canonical"]',

  /** Title elements used for later-phase patching. */
  TITLE: "#video-title, #text.ytd-video-renderer, h3.ytd-rich-grid-media a",
} as const;

/** A detected video. Lightweight descriptor only — no element refs held. */
export interface VideoHit {
  videoId: string;
  /** Where the hit was found, for debugging and later prioritization. */
  source: "link" | "url";
}

/**
 * Collect video IDs currently present in the DOM, de-duplicated, in DOM
 * order. Callers run this after mutations or navigations; it is cheap
 * (querySelectorAll over link selectors only).
 */
export function findVideoHits(root: ParentNode = document): VideoHit[] {
  const seen = new Set<string>();
  const hits: VideoHit[] = [];

  const push = (videoId: string, source: VideoHit["source"]) => {
    if (!seen.has(videoId)) {
      seen.add(videoId);
      hits.push({ videoId, source });
    }
  };

  root.querySelectorAll?.(SELECTORS.WATCH_LINK).forEach((a) => {
    const id = extractVideoId((a as HTMLAnchorElement).href);
    if (id) push(id, "link");
  });

  // Canonical link (watch pages) survives even when links are not rendered.
  root.querySelectorAll?.(SELECTORS.CANONICAL)?.forEach?.((link) => {
    const id = extractVideoId((link as HTMLLinkElement).href);
    if (id) push(id, "link");
  });

  return hits;
}
