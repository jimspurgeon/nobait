/**
 * Background service worker — currently routes only cache-management
 * messages; the thumbnail pipeline runs in the content script (it needs
 * the DOM for blob-URL usage and IndexedDB is shared anyway).
 */

console.info('[nobait] background loaded');

const CLEAR_THUMBS = 'nobait:clear-thumb-cache';

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type === CLEAR_THUMBS) {
    void clearThumbCaches().then(() => {
      (event.source as WindowClient | null)?.postMessage({ type: `${CLEAR_THUMBS}:done` });
    });
  }
});

async function clearThumbCaches(): Promise<void> {
  for (const name of ['nobait-thumbnails', 'nobait-sprites']) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
}
