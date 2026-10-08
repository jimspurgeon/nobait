/**
 * Centralized YouTube DOM selectors (PLAN: "if YouTube changes classes,
 * we fix one file"). Unifies the P2 thumbnail-card extraction with the P3
 * signal-extraction selectors used by the stamp pipeline.
 */

import { extractVideoId } from "../utils/url";

// Re-exported for content-script callers that import from ./dom (P3 shape).
export { extractVideoId };

export const SELECTORS = {
  /** Grid / list items hosting a video card (P2 thumbnail pipeline). */
  GRID_ITEM:
    "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer",
  /** Thumbnail anchor inside a card. */
  THUMBNAIL_LINK: "a#thumbnail.yt-simple-endpoint, a#thumbnail",
  /** Thumbnail image inside a card. */
  THUMBNAIL_IMG: "ytd-thumbnail img, ytd-thumbnail #img, img#img",
  /** Video titles on cards (P3 stamp pipeline). */
  TITLE:
    "#video-title, ytd-rich-item-renderer #video-title, ytd-video-renderer #video-title, #text.ytd-video-renderer",
  /** Watch-page description (P3 signal extraction). */
  WATCH_LINK: 'a[href*="/watch"]',
  /** Canonical link element (P3). */
  CANONICAL: 'link[rel="canonical"]',
} as const;

export interface VideoCard {
  videoId: string;
  /** The primary thumbnail <img> (may be lazily upgraded by YouTube). */
  img: HTMLImageElement | null;
  /** Element that marks a swap as already-done (idempotency). */
  containerEl: Element;
}

export interface VideoHit {
  videoId: string;
  source: "link" | "url";
}

/** Parse an 11-char video ID from any YouTube watch/shorts/embed URL. */
export function videoIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m =
    /[?&]v=([\w-]{11})/.exec(url) ??
    /\/(?:shorts|embed)\/([\w-]{11})/.exec(url);
  return m?.[1] ?? null;
}

/** Extract a video card from a grid item element, null when unusable. */
export function extractCard(el: Element): VideoCard | null {
  const link = el.querySelector(
    SELECTORS.THUMBNAIL_LINK,
  ) as HTMLAnchorElement | null;
  const id = videoIdFromUrl(link?.getAttribute("href") ?? link?.href);
  if (!id) return null;
  let img = el.querySelector(
    SELECTORS.THUMBNAIL_IMG,
  ) as HTMLImageElement | null;
  // YouTube sometimes hides the real <img> behind a bg-image div.
  if (!img) {
    const holder = el.querySelector(
      "yt-img-shadow, .yt-thumb, #thumbnail-container",
    );
    img = holder?.querySelector("img") ?? null;
  }
  return { videoId: id, img, containerEl: el };
}

/**
 * Find the closest ancestor element with the given attribute
 */
export function closestWithAttribute(
  el: Element,
  attr: string,
): Element | null {
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
