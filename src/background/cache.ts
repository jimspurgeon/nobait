/**
 * Background cache stub — IndexedDB-backed results cache arrives in P3.
 * Interface defined now so the content script wiring has a stable contract.
 */

export interface CacheEntry<T> {
  value: T;
  /** Epoch ms when this entry stops being trusted. */
  expiresAt: number;
}

export interface ResultCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** No-op implementation used until the IndexedDB layer lands. */
export const noopCache: ResultCache = {
  async get() {
    return undefined;
  },
  async set() {},
  async delete() {},
  async clear() {},
};
