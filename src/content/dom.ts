/**
 * Centralized YouTube DOM selectors (PLAN: "if YouTube changes classes,
 * we fix one file") plus video-card extraction for the thumbnail module.
 */

export const SELECTORS = {
  GRID_ITEM: 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer',
  THUMBNAIL_LINK: 'a#thumbnail.yt-simple-endpoint, a#thumbnail',
  THUMBNAIL_IMG: 'ytd-thumbnail img, ytd-thumbnail #img, img#img',
  TITLE: '#video-title, #text.ytd-video-renderer',
} as const;

export interface VideoCard {
  videoId: string;
  /** The primary thumbnail <img> (may be lazily upgraded by YouTube). */
  img: HTMLImageElement | null;
  /** Element that marks a swap as already-done (idempotency). */
  containerEl: Element;
}

/** Parse an 11-char video ID from any YouTube watch/shorts/embed URL. */
export function videoIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /[?&]v=([\w-]{11})/.exec(url) ?? /\/(?:shorts|embed)\/([\w-]{11})/.exec(url);
  return m ? m[1] : null;
}

/** Extract a video card from a grid item element, null when unusable. */
export function extractCard(el: Element): VideoCard | null {
  const link = el.querySelector(SELECTORS.THUMBNAIL_LINK) as HTMLAnchorElement | null;
  const id = videoIdFromUrl(link?.getAttribute('href') ?? link?.href);
  if (!id) return null;
  let img = el.querySelector(SELECTORS.THUMBNAIL_IMG) as HTMLImageElement | null;
  // YouTube sometimes hides the real <img> behind a bg-image div.
  if (!img) {
    const holder = el.querySelector('yt-img-shadow, .yt-thumb, #thumbnail-container');
    img = holder?.querySelector('img') ?? null;
  }
  return { videoId: id, img, containerEl: el };
}
