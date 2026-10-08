/**
 * Thumbnail blob cache — content-script side (works equally well in a
 * background worker since it's pure IndexedDB).
 *
 * `key = videoId:frameIndex` → Blob (the cropped JPEG tile), with a 90-day
 * TTL (frames don't go stale). On hit we revive the Blob into a fresh
 * object URL; misses return null so the caller composes it.
 */

const DB_NAME = 'nobait-thumbnails';
const STORE = 'thumbs';

interface ThumbEntry {
  blob: Blob;
  expiresAt: number;
}

export class ThumbnailCache {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('idb open failed'));
    });
    return this.db;
  }

  static key(videoId: string, frameIndex: number): string {
    return `${videoId}:${frameIndex}`;
  }

  async get(videoId: string, frameIndex: number): Promise<Blob | null> {
    try {
      const db = await this.open();
      return await new Promise<Blob | null>((resolve) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(ThumbnailCache.key(videoId, frameIndex));
        req.onsuccess = () => {
          const entry = req.result as ThumbEntry | undefined;
          resolve(entry && entry.expiresAt > Date.now() ? entry.blob : null);
        };
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async put(videoId: string, frameIndex: number, blob: Blob): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(
          { blob, expiresAt: Date.now() + 90 * 864e5 } satisfies ThumbEntry,
          ThumbnailCache.key(videoId, frameIndex)
        );
        tx.oncomplete = () => resolve();
        tx.onabort = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      /* cache write failures must never break rendering */
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      /* ignore */
    }
  }
}
