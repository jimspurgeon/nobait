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
} as const;

/**
 * Extract videoId from a YouTube URL
 */
export function extractVideoId(url: string): string | null {
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
