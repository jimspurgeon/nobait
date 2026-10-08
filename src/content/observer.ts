/**
 * SPA-aware observers (PLAN Stage 0): MutationObserver + soft navigation
 * detection, flushed once per animation frame.
 */

import type { VideoCard } from "./dom";
import { SELECTORS, extractCard } from "./dom";

export interface ObserverHost {
  onCards(cards: VideoCard[]): void;
}

export class SpatObserver {
  private mo: MutationObserver | null = null;
  private url = location.href;
  private urlTimer: number | null = null;
  private pending = new Map<string, VideoCard>();
  private flushScheduled = false;

  constructor(private host: ObserverHost) {}

  start(): void {
    const schedule = (): void => {
      if (this.flushScheduled) return;
      this.flushScheduled = true;
      requestAnimationFrame(() => {
        this.flushScheduled = false;
        if (this.pending.size === 0) return;
        const cards = [...this.pending.values()];
        this.pending.clear();
        this.host.onCards(cards);
      });
    };

    this.mo = new MutationObserver((muts) => {
      let relevant = false;
      for (const m of muts) {
        if (m.type === "childList" && m.addedNodes.length > 0) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1) {
              relevant = true;
              break;
            }
          }
        }
        if (relevant) break;
      }
      if (!relevant) return;
      for (const root of muts) {
        this.scanRoot(
          root.target instanceof Element ? root.target : document.body,
        );
      }
      schedule();
    });
    this.mo.observe(document.body, { childList: true, subtree: true });

    // Soft navigation polling — reliable across Firefox/Chrome.
    this.urlTimer = window.setInterval(() => {
      if (location.href !== this.url) {
        this.url = location.href;
        this.pending.clear();
      }
    }, 250);
  }

  /** Full scan (initial load, SPA hard sections arriving late). */
  initialScan(): void {
    this.scanRoot(document.body);
    const cards = [...this.pending.values()];
    this.pending.clear();
    if (cards.length > 0) this.host.onCards(cards);
  }

  private scanRoot(root: Element): void {
    const els = root.matches?.(SELECTORS.GRID_ITEM)
      ? [
          root,
          ...(root.querySelectorAll(
            SELECTORS.GRID_ITEM,
          ) as NodeListOf<Element>),
        ]
      : (root.querySelectorAll(SELECTORS.GRID_ITEM) as NodeListOf<Element>);
    for (const el of els) {
      if (!(el instanceof Element)) continue;
      const card = extractCard(el);
      if (!card || !card.img) continue;
      // Mark idempotent — skip containers we've already tagged below.
      this.pending.set(card.videoId, card);
    }
  }

  stop(): void {
    this.mo?.disconnect();
    this.mo = null;
    if (this.urlTimer !== null) clearInterval(this.urlTimer);
    this.urlTimer = null;
  }
}
