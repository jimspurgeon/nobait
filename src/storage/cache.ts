import { CacheEntry, NegativeCacheEntry } from "../stamps/types";

/**
 * IndexedDB wrapper for nobait cache
 * Handles TTL expiration and model-version invalidation
 */
export class CacheDB {
  private dbName = "nobait-cache";
  private version = 1;
  private db: IDBDatabase | null = null;

  // Store names
  private stores = {
    ANALYSIS: "analysis",
    NEGATIVE: "negative",
  };

  /**
   * Initialize database connection
   */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Analysis store: videoId -> CacheEntry
        if (!db.objectStoreNames.contains(this.stores.ANALYSIS)) {
          const analysisStore = db.createObjectStore(this.stores.ANALYSIS, {
            keyPath: "videoId",
          });
          analysisStore.createIndex("expiresAt", "expiresAt");
          analysisStore.createIndex("modelVersion", "modelVersion");
        }

        // Negative cache store: videoId -> NegativeCacheEntry
        if (!db.objectStoreNames.contains(this.stores.NEGATIVE)) {
          const negativeStore = db.createObjectStore(this.stores.NEGATIVE, {
            keyPath: "videoId",
          });
          negativeStore.createIndex("timestamp", "timestamp");
        }
      };
    });
  }

  /**
   * Positive cache TTL in ms (default: 7 days)
   */
  static readonly POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  /**
   * Negative cache TTL in ms (default: 24 hours - shorter, so bad videos are retried sooner)
   */
  static readonly NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * Store analysis result (7-day TTL)
   */
  async setAnalysis(entry: CacheEntry): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.stores.ANALYSIS, "readwrite");
      const store = tx.objectStore(this.stores.ANALYSIS);

      store.put(entry);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get analysis result (checks TTL automatically)
   */
  async getAnalysis(
    videoId: string,
    modelVersion: string,
  ): Promise<CacheEntry | null> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.stores.ANALYSIS, "readonly");
      const store = tx.objectStore(this.stores.ANALYSIS);
      const request = store.get(videoId);

      request.onsuccess = () => {
        const entry = request.result as CacheEntry | undefined;

        if (!entry) {
          resolve(null);
          return;
        }

        // Check expiration
        const now = Date.now();
        if (now > entry.expiresAt) {
          // Delete expired entry
          this.deleteAnalysis(videoId).catch(console.error);
          resolve(null);
          return;
        }

        // Check model version invalidation
        if (entry.modelVersion !== modelVersion) {
          resolve(null);
          return;
        }

        resolve(entry);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete analysis entry
   */
  async deleteAnalysis(videoId: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.stores.ANALYSIS, "readwrite");
      const store = tx.objectStore(this.stores.ANALYSIS);

      store.delete(videoId);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Store negative cache entry
   */
  async setNegative(entry: NegativeCacheEntry): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.stores.NEGATIVE, "readwrite");
      const store = tx.objectStore(this.stores.NEGATIVE);

      store.put(entry);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get negative cache entry (checks TTL automatically)
   */
  async getNegative(videoId: string): Promise<NegativeCacheEntry | null> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.stores.NEGATIVE, "readonly");
      const store = tx.objectStore(this.stores.NEGATIVE);
      const request = store.get(videoId);

      request.onsuccess = () => {
        const entry = request.result as NegativeCacheEntry | undefined;

        if (!entry) {
          resolve(null);
          return;
        }

        // Check expiration
        const now = Date.now();
        const expiresAt = entry.timestamp + entry.ttlMs;
        if (now > expiresAt) {
          // Delete expired entry
          this.deleteNegative(videoId).catch(console.error);
          resolve(null);
          return;
        }

        resolve(entry);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete negative cache entry
   */
  async deleteNegative(videoId: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.stores.NEGATIVE, "readwrite");
      const store = tx.objectStore(this.stores.NEGATIVE);

      store.delete(videoId);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Clear all expired entries from both stores
   */
  async cleanup(): Promise<void> {
    if (!this.db) await this.init();
    const now = Date.now();

    await Promise.all([
      this.cleanupStore(
        this.stores.ANALYSIS,
        (entry: CacheEntry) => now > entry.expiresAt,
      ),
      this.cleanupStore(
        this.stores.NEGATIVE,
        (entry: NegativeCacheEntry) => now > entry.timestamp + entry.ttlMs,
      ),
    ]);
  }

  /**
   * Iterate a store's cursor and delete entries matching a predicate
   */
  private cleanupStore(
    storeName: string,
    isExpired: (entry: any) => boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          if (isExpired(cursor.value)) {
            cursor.delete();
          }
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Count entries in both stores (for the options-page cache status).
   */
  async counts(): Promise<{ analysisCount: number; negativeCount: number }> {
    if (!this.db) await this.init();

    const count = (storeName: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const tx = this.db!.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

    const [analysisCount, negativeCount] = await Promise.all([
      count(this.stores.ANALYSIS),
      count(this.stores.NEGATIVE),
    ]);
    return { analysisCount, negativeCount };
  }

  /**
   * Delete every entry from both object stores (data-level clear,
   * unlike close()+init() which only recycles the connection).
   */
  async clearAll(): Promise<void> {
    if (!this.db) await this.init();

    const clearStore = (storeName: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const tx = this.db!.transaction(storeName, "readwrite");
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

    await Promise.all([
      clearStore(this.stores.ANALYSIS),
      clearStore(this.stores.NEGATIVE),
    ]);
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Singleton instance for use across modules
export const cacheDB = new CacheDB();
