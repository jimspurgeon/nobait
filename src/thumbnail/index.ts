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
import { spriteViaBackground } from "./sprite-bridge";
import type { FramePosition } from "./types";
import type { StoryboardLevel } from "./storyboard";

const SPEC_TTL_MS = 90 * 864e5;
const SPEC_DB = "nobait-sprites";
const SPEC_STORE = "specs";
/** Preferred minimum tile width — matches YouTube's L2/L3 320px tiles. */
const MIN_TILE_WIDTH = 320;

/** Failure stages for thumbnail resolution (used in stats). */
export type ThumbFailStage = "innertube" | "spec-parse" | "sprite" | "fallback";

/** Per-video failure reason (for stats/debug). */
export interface ThumbFailure {
  videoId: string;
  /** Every stage that failed for this video, in order. */
  stages: ThumbFailStage[];
  /** First recorded error message, if any. */
  message?: string;
}

/** Aggregate thumbnail batch stats (exposed via window.__nobaitStats). */
export interface ThumbBatchStats {
  total: number;
  swapped: number;
  failures: ThumbFailure[];
}

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

/**
 * One-line batch summary, logged at info when any video in the batch
 * failed to swap: e.g.
 *   [nobait] thumbs: 12 cards, 9 swapped, 3 kept-original (sprite: 2, innertube: 1)
 * With nothing failing, batches stay silent (successful runs shouldn't
 * spam the console on every scroll).
 */
function logBatchSummary(
  total: number,
  swapped: number,
  failures: ThumbFailure[],
): void {
  if (failures.length === 0) return;
  const byStage = new Map<string, number>();
  for (const f of failures) {
    for (const stage of f.stages) {
      byStage.set(stage, (byStage.get(stage) ?? 0) + 1);
    }
  }
  const breakdown = [...byStage.entries()]
    .map(([stage, n]) => `${stage}: ${n}`)
    .join(", ");
  console.info(
    `[nobait] thumbs: ${total} cards, ${swapped} swapped, ` +
      `${failures.length} kept-original (${breakdown})`,
  );
}

export class ThumbnailManager {
  private cache = new ThumbnailCache();
  /** videoId → in-flight pipeline promise (request coalescing). */
  private inflight = new Map<string, Promise<string | null>>();
  /** In-memory sprite bitmap cache: sheet URL → ImageBitmap. */
  private sprites = new Map<string, ImageBitmap>();
  private fetchImpl: typeof fetch;
  private position: FramePosition;

  /**
   * Failure registry keyed by videoId (most recent failure per video).
   * Consumed by getBatchStats() and the status chip.
   */
  private failures = new Map<string, ThumbFailure>();

  /**
   * Cap on retained failure entries. Permanently failing videos (live
   * streams, rentals) would otherwise grow the registry — and the
   * window.__nobaitStats copy per batch — unbounded over a long SPA
   * session. Oldest entries are evicted first (Map preserves insertion
   * order).
   */
  private static readonly MAX_FAILURES = 200;

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

  /** Cumulative batch counters (exposed via window.__nobaitStats). */
  private statsTotal = 0;
  private statsSwapped = 0;

  /** Snapshot of cumulative stats (for the status chip/__nobaitStats). */
  getStats(): ThumbBatchStats {
    return {
      total: this.statsTotal,
      swapped: this.statsSwapped,
      failures: this.getFailures(),
    };
  }

  /** Snapshot of cumulative failure stats (for the status chip/console). */
  getFailures(): ThumbFailure[] {
    return [...this.failures.values()];
  }

  /** Clear the failure registry (e.g. when restarting a batch scan). */
  clearFailures(): void {
    this.failures.clear();
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
        if (url) {
          results.set(id, url);
          // Resolved (possibly via fallback frame) — this video is fine.
          this.failures.delete(id);
        }
      }),
    );
    this.statsTotal += videoIds.length;
    this.statsSwapped += results.size;
    logBatchSummary(videoIds.length, results.size, this.getFailures());
    return results;
  }

  private async resolveOne(videoId: string): Promise<string | null> {
    // 1. Spec (cached → InnerTube). On missing/unusable spec, degrade to
    //    the always-available mid-video frame thumbnail (hq2.jpg).
    const spec = (await specGet(videoId)) ?? (await this.fetchSpec(videoId));
    if (!spec) return this.resolveFallbackFrame(videoId);

    // 2. Frame math (deterministic).
    let level: StoryboardLevel | null = null;
    try {
      level = selectLevel(spec, MIN_TILE_WIDTH);
    } catch {
      level = null;
    }
    if (!level) return this.resolveFallbackFrame(videoId);
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
      // Sprite fetch failed (expired sig, removed sheet, rate limit…) —
      // fall back to the mid-video frame rather than showing nothing.
      if (!blob) {
        this.recordFailure(videoId, "sprite", `sheet ${sheetUrl}`);
        return this.resolveFallbackFrame(videoId);
      }
      bitmap = await createImageBitmap(blob);
      this.sprites.set(sheetUrl, bitmap);
    }
    const out = await cropTile(bitmap, level, rect);
    if (!out) return this.resolveFallbackFrame(videoId);
    void this.cache.put(videoId, frameIndex, out);
    return URL.createObjectURL(out);
  }

  /**
   * Record a pipeline failure for `videoId`. Videos failing multiple
   * stages (InnerTube down → fallback also blocked) accumulate every
   * stage in order; entries for videos that eventually resolve are
   * dropped by {@link getMany}, so the registry only holds genuine
   * no-swap videos.
   */
  private recordFailure(
    videoId: string,
    stage: ThumbFailStage,
    message?: string,
  ): void {
    const entry = this.failures.get(videoId);
    if (entry) {
      if (!entry.stages.includes(stage)) entry.stages.push(stage);
    } else {
      while (this.failures.size >= ThumbnailManager.MAX_FAILURES) {
        const oldest = this.failures.keys().next().value;
        if (oldest === undefined) break;
        this.failures.delete(oldest);
      }
      this.failures.set(videoId, {
        videoId,
        stages: [stage],
        message,
      });
    }
  }

  /**
   * Guaranteed-available replacement frame: YouTube exposes four real
   * video-frame thumbnails (0/25/50/75%) as public, unsigned images.
   * `hq2` is the 50% frame. No InnerTube, no signatures, no rate limit.
   */
  private resolveFallbackFrame(
    videoId: string,
    key: "1" | "2" | "3" = "2",
  ): Promise<string | null> {
    const p =
      this.fallbackLoads.get(videoId) ??
      spriteViaBackground(`https://i.ytimg.com/vi/${videoId}/hq${key}.jpg`)
        .catch((err: unknown) => {
          this.recordFailure(videoId, "fallback", String(err));
          return null;
        })
        .then((bytes) =>
          bytes
            ? URL.createObjectURL(
                new Blob([bytes.slice().buffer], { type: "image/jpeg" }),
              )
            : null,
        );
    this.fallbackLoads.set(videoId, p);
    return p;
  }

  private async fetchSpec(
    videoId: string,
  ): Promise<PlayerStoryboardSpec | null> {
    let pr: unknown;
    try {
      pr = await fetchPlayerResponse(videoId, this.fetchImpl);
    } catch (err) {
      // InnerTube unreachable (ytcfg key missing, endpoint error, network
      // blocked by tracking protection…). Degrade to the fallback frame,
      // but keep the reason for the stats surface.
      this.recordFailure(videoId, "innertube", String(err));
      return null;
    }
    const spec = parseStoryboardSpec(pr);
    if (!spec) {
      // Player response had no usable storyboards (rentals, live streams,
      // region blocks) — degrade, but record why.
      this.recordFailure(
        videoId,
        "spec-parse",
        "player_response contained no storyboard spec",
      );
      return null;
    }
    await specPut(videoId, spec);
    return spec;
  }

  private spriteLoads = new Map<string, Promise<Blob | null>>();
  private fallbackLoads = new Map<string, Promise<string | null>>();

  private loadSprite(url: string): Promise<Blob | null> {
    let p = this.spriteLoads.get(url);
    if (!p) {
      // i.ytimg.com sends no CORS headers, so a content-script fetch
      // cannot read the body. Proxy the bytes through the background
      // script, whose host_permissions for *.ytimg.com exempt it from
      // CORS, then rehydrate a Blob in the content world.
      p = spriteViaBackground(url)
        .then((bytes) =>
          bytes
            ? new Blob([bytes.slice().buffer], { type: "image/jpeg" })
            : null,
        )
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
    this.fallbackLoads.clear();
  }
}
