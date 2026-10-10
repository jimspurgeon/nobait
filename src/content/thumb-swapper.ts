/**
 * Thumbnail injector: when new video cards arrive, request their thumbnails
 * and apply the crossfade swap (reduced-motion aware). Batches swaps so
 * 60 simultaneous renders stay inside a single rAF budget.
 */

import type { VideoCard } from "./dom";
import type { FramePosition } from "../thumbnail/types";
import { batchCrossfade } from "./ui";
import { ThumbnailManager } from "../thumbnail/index";

export class ThumbnailSwapper {
  private thumbMgr: ThumbnailManager;
  private visited = new Set<string>();
  private onDone?: (videoId: string) => void;

  constructor(opts?: {
    position?: FramePosition;
    fetchImpl?: typeof fetch;
    onDone?: (videoId: string) => void;
  }) {
    this.thumbMgr = new ThumbnailManager({
      position: opts?.position,
      fetchImpl: opts?.fetchImpl,
    });
    this.onDone = opts?.onDone;
  }

  setPosition(position: FramePosition): void {
    this.thumbMgr.setPosition(position);
  }

  /**
   * Resolve & inject thumbnails for newly-seen cards. Null entries degrade
   * silently (original thumbnails persist).
   */
  async applyCards(cards: VideoCard[]): Promise<void> {
    const byId = new Map<string, HTMLImageElement>();
    for (const c of cards) {
      if (!c.img || this.visited.has(c.videoId)) continue;
      if (c.img.dataset.nobaitThumb === "1") {
        this.visited.add(c.videoId);
        continue;
      }
      byId.set(c.videoId, c.img);
    }
    if (byId.size === 0) return;

    const urls = await this.thumbMgr.getMany([...byId.keys()]);
    const swaps: Array<{ img: HTMLImageElement; src: string }> = [];
    for (const [id, url] of urls.entries()) {
      const img = byId.get(id);
      if (!img || !img.isConnected) continue;
      img.dataset.nobaitThumb = "1";
      swaps.push({ img, src: url });
      this.visited.add(id);
      this.onDone?.(id);
    }
    if (swaps.length > 0) batchCrossfade(swaps);
  }

  /**
   * Immediate one-off for a specific video. Used by hover prefetch or
   * watch-page injection.
   */
  async inject(videoId: string, img: HTMLImageElement): Promise<void> {
    if (this.visited.has(videoId) || img.dataset.nobaitThumb === "1") return;
    const url = await this.thumbMgr.getThumbUrl(videoId);
    if (!url) return;
    img.dataset.nobaitThumb = "1";
    batchCrossfade([{ img, src: url }]);
    this.visited.add(videoId);
    this.onDone?.(videoId);
  }

  dispose(): void {
    this.thumbMgr.dispose();
  }
}
