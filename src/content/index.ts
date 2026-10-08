/**
 * Content script: observes YouTube's DOM for both:
 *   - thumbnail swaps (P2 pipeline)
 *   - credibility stamps & title rewrites (P3/P4 pipeline)
 */

import { SELECTORS, extractVideoId } from "./dom";
import { sendToBackground, MessageResponse } from "../utils/messages";
import { StampTier, VALID_STAMP_TIERS } from "../stamps/types";
import { buildBadge } from "../stamps/badges";
import { attachTooltip } from "../stamps/tooltips";
import { SpatObserver } from "./observer";
import { ThumbnailSwapper } from "./thumb-swapper";
import { loadSettings, type NobaitSettings } from "./settings";
import "../styles/base.css";

declare const browser: any;
declare const chrome: any;

console.info("[nobait] content script loading (stamps + thumbnails)...");

/** Videos already processed for stamps (avoid duplicate work) */
const seen = new Map<
  string,
  { titleEl: HTMLElement; stampHost: HTMLElement }
>();

/** Fair scheduling for IntersectionObserver callbacks */
const pendingCards = new Set<HTMLElement>();
let rafId: number | null = null;

async function main(): Promise<void> {
  const settings: NobaitSettings = await loadSettings();

  // --- Thumbnail swap (P2) ---
  const swapper = new ThumbnailSwapper({
    position: settings.thumbnailPosition,
    onDone: (id) => {
      if (settings.debug) console.debug("[nobait] thumbnail swapped:", id);
    },
  });

  const observer = new SpatObserver({
    onCards: (cards) => {
      void swapper.applyCards(cards);
    },
  });

  // --- Stamps pipeline (P3/P4) ---
  scanAndProcess();
  observeMutations();
  observeNavigation();
  listenForResults();

  // Diagnostics hook (see AGENTS.md debugging tips).
  window.addEventListener("nobait:debug", () => {
    console.debug("[nobait] settings:", settings);
  });

  window.addEventListener("pagehide", () => {
    observer.stop();
    swapper.dispose();
  });

  console.log("[nobait] content script ready (stamps + thumbnails)");
}

/**
 * Scan the current DOM for video cards and process new ones for stamps
 */
function scanAndProcess(): void {
  const titleElements = document.querySelectorAll<HTMLElement>(SELECTORS.TITLE);

  for (const titleEl of titleElements) {
    processTitle(titleEl);
  }
}

/**
 * Process a single title element - extract video info and request evaluation
 */
async function processTitle(titleEl: HTMLElement): Promise<void> {
  const anchor = titleEl.closest("a[href]");
  const href = anchor?.getAttribute("href") || "";
  const videoId = extractVideoId(
    href.startsWith("/") ? `https://www.youtube.com${href}` : href,
  );
  const title = (titleEl.textContent || "").trim();

  if (!videoId || !title) return;

  // Skip if already processed
  if (seen.has(videoId)) return;

  // Create stamp container
  const stampHost = document.createElement("span");
  stampHost.className = "nobait-stamp-host";
  stampHost.style.cssText =
    "display:inline-flex;align-items:center;margin-left:6px;vertical-align:middle;";
  titleEl.parentElement?.insertBefore(stampHost, titleEl.nextSibling);

  seen.set(videoId, { titleEl, stampHost });

  // Request evaluation from background
  try {
    const response: MessageResponse<{
      result?: {
        rewrittenTitle: string;
        stamp: StampTier;
        stampExplanation: string;
      };
    }> = await sendToBackground({ type: "EVALUATE_VIDEO", videoId, title });
    if (response.success && response.data?.result) {
      applyStamp(stampHost, response.data.result);
    }
  } catch (err) {
    console.error("[nobait] Failed to evaluate video:", videoId, err);
  }
}

/**
 * Observe DOM mutations (coalesced once per animation frame)
 */
function observeMutations(): void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) {
          pendingCards.add(node);
        }
      }
    }
    scheduleScan();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/**
 * Schedule a coalesced scan on next animation frame
 */
function scheduleScan(): void {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    const nodes = new Set(pendingCards);
    pendingCards.clear();
    for (const node of nodes) {
      const titleEl = node.querySelector<HTMLElement>(SELECTORS.TITLE);
      if (titleEl) processTitle(titleEl).catch(console.error);
    }
  });
}

/**
 * Observe SPA navigation events
 */
function observeNavigation(): void {
  // Firefox: navigation event if available
  const nav = (globalThis as { navigation?: EventTarget }).navigation;
  if (nav && typeof nav.addEventListener === "function") {
    nav.addEventListener("navigate", scheduleScan);
  }

  // history.pushState interception + popstate
  window.addEventListener("popstate", scheduleScan);

  const origPushState = history.pushState.bind(history);
  history.pushState = (...args: Parameters<typeof history.pushState>) => {
    const result = origPushState(...args);
    scheduleScan();
    return result;
  };
}

/**
 * Listen for streamed results from background
 */
function listenForResults(): void {
  const api =
    typeof browser !== "undefined"
      ? browser
      : typeof chrome !== "undefined"
        ? chrome
        : null;
  if (!api?.runtime?.onMessage) return;

  if (typeof browser !== "undefined") {
    browser.runtime.onMessage.addListener((message: any) => {
      if (message?.type === "NEW_RESULT") {
        applyResult(message.result);
      }
      return false;
    });
  } else if (typeof chrome !== "undefined") {
    chrome.runtime.onMessage.addListener((message: any) => {
      if (message?.type === "NEW_RESULT") {
        applyResult(message.result);
      }
      return false;
    });
  }
}

/**
 * Apply a result to the DOM immediately when chunk arrives (streaming)
 */
function applyResult(result: {
  videoId: string;
  rewrittenTitle: string;
  stamp: string;
  stampExplanation: string;
}): void {
  const entry = seen.get(result.videoId);
  if (!entry) return;

  // Patch title
  entry.titleEl.textContent = result.rewrittenTitle;
  entry.titleEl.setAttribute("data-nobait-original", result.rewrittenTitle);

  // Apply stamp (validate tier)
  const tier = VALID_STAMP_TIERS.includes(result.stamp as StampTier)
    ? (result.stamp as StampTier)
    : StampTier.UNSURE;
  applyStamp(entry.stampHost, {
    stamp: tier,
    stampExplanation: result.stampExplanation,
  });
}

/**
 * Apply a stamp badge to a host element
 */
function applyStamp(
  host: HTMLElement,
  result: { stamp: StampTier; stampExplanation: string },
): void {
  // Clean any existing
  host.innerHTML = "";
  host._nobaitTooltipCleanup?.();

  const badge = buildBadge(result.stamp, result.stampExplanation);
  host.appendChild(badge);

  // Attach tooltip
  attachTooltip(host, result.stampExplanation, { offsetX: 8, offsetY: 8 });
}

void main();
