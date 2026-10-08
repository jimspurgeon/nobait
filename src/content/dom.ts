import { extractVideoId } from "../utils/url";

/**
 * YouTube-specific DOM selectors - centralized here so YouTube changes
 * only require fixing one file
 */
export const SELECTORS = {
  /** Video title on home/search/sidebar cards */
  TITLE: '#video-title, ytd-rich-item-renderer #video-title, ytd-video-renderer #video-title',
  /** Thumbnail image on cards */
  THUMBNAIL: 'ytd-thumbnail #img, ytd-thumbnail img',
  /** Video description on watch page */
  DESCRIPTION: '#description-inline-expander',
  /** Compact video renderer link (sidebar) */
  COMPACT_LINK: 'ytd-compact-video-renderer #video-title',
  /** Lockup viewmodel-based grid item (new YouTube) */
  LOCKUP: 'ytd-lockup-view-model, .ytLockupViewModelHost',
  /** Channel name on cards */
  CHANNEL: '#channel-name #text, .yt-content-secondary-view-model__text',
  /** Watch page title */
  WATCH_TITLE: 'h1.ytd-watch-metadata title, h1.ytd-watch-metadata',
  /** Links to watch pages — the most reliable video-ID carrier anywhere. */
  WATCH_LINK: 'a[href*="/watch?v="][href]',
  /** Compact grid/list cards (home, search results, sidebar). */
  VIDEO_RENDERER:
    "ytd-video-renderer, ytd-rich-grid-media, ytd-compact-video-renderer, ytd-grid-video-renderer",
  /** Currently-playing video element (watch page). */
  PLAYER: "#movie_player video, video.html5-main-video",
  /** Canonical anchor on watch pages. */
  CANONICAL: 'link[rel="canonical"]',
} as const;

/** A detected video. Lightweight descriptor only — no element refs held. */
export interface VideoHit {
  videoId: string;
  /** Where the hit was found, for debugging and later prioritization. */
  source: "link" | "url";
}

/**
 * Extract videoId from a YouTube URL (moved from utils/url to avoid circular dep)
 */
export function extractVideoIdFromUrl(url: string): string | null {
  if (!url) return null;
  const match = url.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * Find the closest ancestor element with the given attribute
 */
export function closestWithAttribute(el: Element, attr: string): Element | null {
  let current: Element | null = el;
  while (current) {
    if (current.hasAttribute(attr)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
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
