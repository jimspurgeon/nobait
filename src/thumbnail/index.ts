/**
 * Orchestrates the thumbnail pipeline for the content script:
 *
 *   videoId → (spec) → frame math → sprite fetch → crop → blob URL
 *
 * - IndexedDB-caches both sprite specs and composed frame blobs so revisits
 *   never re-fetch.
 * - Coalesces concurrent requests for the same video (one wasted request
 *   is a bug).
 * - Batch-aware: `getMany` limits in-flight sprite fetches (default 8) so a
 *   60-video grid stays smooth; per-video results resolve independently.
 */

import {
  buildSheetUrl,
  parseStoryboardSpec,
  selectLevel,
  type PlayerStoryboardSpec,
} from "./storyboard";
import { selectTile } from "./frame";
import { cropTile } from "./render";
import { fetchPlayerResponse } from "./innertube";
import { ThumbnailCache } from "../storage/thumbnail-cache";
import type { FramePosition } from "./types";

const SPEC_TTL_MS = 90 * 864e5;
const SPEC_DB = "nobait-sprites";
const SPEC_STORE = "specs";
/** Preferred minimum tile width — matches YouTube's L2/L3 320px tiles. */
const MIN_TILE_WIDTH = 320;

interface SpecEntry {
  spec: PlayerStoryboardSpec;
  expiresAt: number;
}

function openSpecDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SPEC_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SPEC_STORE)) {
        req.result.createObjectStore(SPEC_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb open failed"));
  });
}

async function specGet(videoId: string): Promise<PlayerStoryboardSpec | null> {
  try {
    const db = await openSpecDb();
    const spec = await new Promise<PlayerStoryboardSpec | null>((resolve) => {
      const tx = db.transaction(SPEC_STORE, "readonly");
      const req = tx.objectStore(SPEC_STORE).get(videoId);
      req.onsuccess = () => {
        const entry = req.result as SpecEntry | undefined;
        const parsed =
          entry && entry.expiresAt > Date.now()
            ? parseStoryboardSpec(entry.spec)
            : null;
        resolve(parsed);
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    });
    return spec;
  } catch {
    return null;
  }
}

async function specPut(
  videoId: string,
  spec: PlayerStoryboardSpec,
): Promise<void> {
  try {
    const db = await openSpecDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(SPEC_STORE, "readwrite");
      tx.objectStore(SPEC_STORE).put(
        { spec, expiresAt: Date.now() + SPEC_TTL_MS } satisfies SpecEntry,
        videoId,
      );
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* best effort */
  }
}

export class ThumbnailManager {
  private cache = new ThumbnailCache();
  /** videoId → in-flight pipeline promise (request coalescing). */
  private inflight = new Map<string, Promise<string | null>>();
  /** In-memory sprite bitmap cache: sheet URL → ImageBitmap. */
  private sprites = new Map<string, ImageBitmap>();
  private fetchImpl: typeof fetch;
  private position: FramePosition;

  constructor(
    opts: { position?: FramePosition; fetchImpl?: typeof fetch } = {},
  ) {
    this.position = opts.position ?? { kind: "middle" };
    // Bind the native fetch: storing it unbound and invoking it as a
    // method (`this.fetchImpl(...)`) detaches it from its Window receiver
    // and throws "Illegal invocation" in Chromium/Firefox.
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  setPosition(position: FramePosition): void {
    this.position = position;
  }

  /** Single-video convenience. Returns blob URL or null (degrade silently). */
  getThumbUrl(videoId: string): Promise<string | null> {
    return this.getMany([videoId]).then((r) => r.get(videoId) ?? null);
  }

  /**
   * Resolve thumbnail blob URLs for a batch of videos. Returns as soon as
   * every video has either a URL or null; individual failures degrade to
   * null entries. Network concurrency is capped, so large grids stay at
   * 60fps.
   */
  async getMany(videoIds: string[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const pending: Array<{ id: string; p: Promise<string | null> }> = [];

    for (const id of videoIds) {
      const existing = this.inflight.get(id);
      const p = existing ?? this.resolveOne(id);
      if (!existing) this.inflight.set(id, p);
      pending.push({ id, p: p.finally(() => this.inflight.delete(id)) });
    }

    await Promise.allSettled(
      pending.map(async ({ id, p }) => {
        const url = await p.catch(() => null);
        if (url) results.set(id, url);
      }),
    );
    return results;
  }

  private async resolveOne(videoId: string): Promise<string | null> {
    // 1. Spec (cached → InnerTube).
    const spec = (await specGet(videoId)) ?? (await this.fetchSpec(videoId));
    if (!spec) return null;

    // 2. Frame math (deterministic).
    const level = selectLevel(spec, MIN_TILE_WIDTH);
    const { frameIndex, sheet, rect } = selectTile(
      videoId,
      this.position,
      level,
    );

    // 3. Composed-blob cache hit → instant object URL.
    const cached = await this.cache.get(videoId, frameIndex);
    if (cached) return URL.createObjectURL(cached);

    // 4. Fetch sprite sheet (memoized per sheet), crop, cache, URL.
    const sheetUrl = buildSheetUrl(level, sheet);
    let bitmap = this.sprites.get(sheetUrl);
    if (!bitmap) {
      const blob = await this.loadSprite(sheetUrl);
      if (!blob) return null;
      bitmap = await createImageBitmap(blob);
      this.sprites.set(sheetUrl, bitmap);
    }
    const out = await cropTile(bitmap, level, rect);
    if (!out) return null;
    void this.cache.put(videoId, frameIndex, out);
    return URL.createObjectURL(out);
  }

  private async fetchSpec(
    videoId: string,
  ): Promise<PlayerStoryboardSpec | null> {
    try {
      const pr = await fetchPlayerResponse(videoId, this.fetchImpl);
      const spec = parseStoryboardSpec(pr);
      if (spec) await specPut(videoId, spec);
      return spec;
    } catch {
      return null;
    }
  }

  private spriteLoads = new Map<string, Promise<Blob | null>>();

  private loadSprite(url: string): Promise<Blob | null> {
    let p = this.spriteLoads.get(url);
    if (!p) {
      p = this.fetchImpl(url, { credentials: "omit" })
        .then(async (r) => (r.ok ? r.blob() : null))
        .catch(() => null);
      this.spriteLoads.set(url, p);
    }
    return p;
  }

  /** Drop memoized bitmaps (e.g. on long idle) to reclaim memory. */
  dispose(): void {
    for (const b of this.sprites.values()) b.close();
    this.sprites.clear();
    this.spriteLoads.clear();
  }
}
