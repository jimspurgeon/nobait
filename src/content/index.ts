/**
 * Content script: observes YouTube's DOM for both:
 *   - thumbnail swaps (P2 pipeline)
 *   - credibility stamps & title rewrites (P3/P4 pipeline)
 */

import { SELECTORS, extractVideoId } from "./dom";
import { sendToBackground, type MessageResponse } from "../utils/messages";
import { StampTier, VALID_STAMP_TIERS } from "../stamps/types";
import { buildBadge } from "../stamps/badges";
import { attachTooltip } from "../stamps/tooltips";
import { SpatObserver } from "./observer";
import { ThumbnailSwapper } from "./thumb-swapper";
import { loadSettings, onSettingsChanged, type Settings } from "./settings";
import { escapeDomText } from "./signals";
import { webext } from "../utils/webext";
import { setAnimationIntensity, applyResult as uiApplyResult } from "./ui";
import "../styles/base.css";

console.info("[nobait] content script loading (stamps + thumbnails)...");

/** Videos already processed for stamps (avoid duplicate work)
 * Cleared on SPA navigation so revisits re-patch titles.
 */
const seen = new Map<
  string,
  { titleEl: HTMLElement; stampHost: HTMLElement }
>();

/** Latest settings snapshot (live-updated via storage.onChanged). */
let currentSettings: Settings | null = null;

/** Fair scheduling for IntersectionObserver callbacks */
const pendingCards = new Set<HTMLElement>();
let rafId: number | null = null;

/** Wait for document.body (content script runs at document_start). */
function onBodyReady(cb: () => void): void {
  if (document.body) {
    cb();
    return;
  }
  document.addEventListener("DOMContentLoaded", cb, { once: true });
}

async function main(): Promise<void> {
  let settings: Settings = await loadSettings();
  currentSettings = settings;

  // Apply animation intensity from settings (P7; "off" acts like reduced motion).
  setAnimationIntensity(
    settings.animations.enabled ? settings.animations.intensity : "off",
  );

  // --- Thumbnail swap (P2) ---
  const swapper = new ThumbnailSwapper({
    position: settings.thumbnails.position,
    onDone: (id) => {
      if (settings.debug) console.debug("[nobait] thumbnail swapped:", id);
    },
  });

  const observer = new SpatObserver({
    onCards: (cards) => {
      void swapper.applyCards(cards);
    },
  });

  // Content script runs at document_start — document.body may be null.
  // All DOM-touching setup must wait for body, else observer construction
  // throws and silently kills the rest of main().
  onBodyReady(() => {
    observer.start();
    observer.initialScan();

    // --- Stamps pipeline (P3/P4) ---
    scanAndProcess();
    observeMutations();
    observeNavigation();
    listenForResults();
  });

  // Live settings: storage.onChanged → apply without reload
  const unsubscribeSettings = onSettingsChanged((next) => {
    currentSettings = next;
    settings = next;
    swapper.setPosition(next.thumbnails.position);
    setAnimationIntensity(
      next.animations.enabled ? next.animations.intensity : "off",
    );
    // Stamp visibility: hide/show all existing badge hosts.
    document
      .querySelectorAll<HTMLElement>(".nobait-stamp-host")
      .forEach((host) => {
        host.style.display = next.stamps.visible ? "" : "none";
      });
  });

  // Diagnostics hook (see AGENTS.md debugging tips).
  window.addEventListener("nobait:debug", () => {
    console.debug("[nobait] settings:", settings);
  });

  // E2E/diagnostics relay: lets a page script drive one background round
  // trip (or a settings write) and reflect the response back. Used by
  // e2e/ondevice_smoke.py. Note: the response is ALSO written to the
  // `data-nobait-e2e-result` attribute on <html> because CustomEvent
  // details dispatched from a content script are Xray-opaque to
  // privileged page script (Marionette/WebDriver) — DOM attributes are
  // visible across worlds. The custom event is kept for same-world
  // consumers.
  window.addEventListener("nobait:e2e", (ev) => {
    const detail = (ev as CustomEvent).detail as {
      message?: { type: string; [k: string]: unknown };
      setSettings?: Record<string, unknown>;
    } | null;
    void (async () => {
      let response: unknown;
      try {
        if (detail?.setSettings) {
          const storage = webext.storage?.local;
          if (!storage) throw new Error("storage API unavailable");
          // Must use SETTINGS_KEY ("nobait:settings"), not "settings":
          // the settings module (and its storage.onChanged listener) only
          // ever looks at that key.
          const SETTINGS_KEY = "nobait:settings";
          const cur =
            ((await storage.get(SETTINGS_KEY)) as Record<string, unknown>) ??
            {};
          const next = {
            ...(cur[SETTINGS_KEY] as Record<string, unknown> | undefined),
            ...detail.setSettings,
          };
          await storage.set({ [SETTINGS_KEY]: next });
          response = { success: true };
        } else if (detail?.message) {
          response = await sendToBackground(
            detail.message as Parameters<typeof sendToBackground>[0],
          );
        } else {
          response = { success: false, error: "bad relay request" };
        }
      } catch (e) {
        response = { success: false, error: String(e) };
      }
      document.documentElement.setAttribute(
        "data-nobait-e2e-result",
        JSON.stringify(response, (_k, v) =>
          typeof v === "bigint" ? String(v) : v,
        ),
      );
      window.dispatchEvent(
        new CustomEvent("nobait:e2e-result", { detail: response }),
      );
    })();
  });

  // Clear seen cache on SPA navigation so revisits re-patch (QA seam note).
  window.addEventListener("popstate", () => {
    seen.clear();
  });
  const navApi = (globalThis as { navigation?: EventTarget }).navigation;
  if (navApi && typeof navApi.addEventListener === "function") {
    navApi.addEventListener("navigate", () => seen.clear());
  }

  window.addEventListener("pagehide", () => {
    unsubscribeSettings();
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
  // Card titles sit inside a /watch link; the watch-page h1 does not —
  // fall back to the page URL (or its canonical form) for that case.
  const videoId =
    extractVideoId(
      href.startsWith("/") ? `https://www.youtube.com${href}` : href,
    ) ?? extractVideoId(location.href);
  const title = escapeDomText(titleEl.textContent || "");

  if (!videoId || !title) return;

  // Skip if already processed
  if (seen.has(videoId)) return;

  // Create stamp container
  const stampHost = document.createElement("span");
  stampHost.className = "nobait-stamp-host";
  stampHost.style.cssText =
    "display:inline-flex;align-items:center;margin-left:6px;vertical-align:middle;";
  titleEl.parentElement?.insertBefore(stampHost, titleEl.nextSibling);

  // Hide immediately if stamps are disabled in settings
  const cfg = currentSettings ?? (await loadSettings());
  if (!cfg.stamps.visible) {
    stampHost.style.display = "none";
  }

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
      applyStreamedResult({ ...response.data.result, videoId });
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
  const runtimeApi = webext.runtime;
  if (!runtimeApi?.onMessage) return;

  runtimeApi.onMessage.addListener((rawMessage: unknown) => {
    const message = rawMessage as {
      type?: string;
      result?: StreamedResult;
    };
    if (message?.type === "NEW_RESULT" && message.result) {
      applyStreamedResult(message.result);
    }
    return false;
  });
}

/**
 * Shape of a streamed result message from the background worker.
 */
interface StreamedResult {
  videoId: string;
  rewrittenTitle: string;
  stamp: string;
  stampExplanation: string;
  timing?: { inferenceMs: number; cached?: boolean };
}

/**
 * Apply a streamed result to the DOM (M2 wiring).
 *
 * Delegates to the ui.ts `applyResult` facade so the full P5 choreography
 * (title decode scramble → stamp pop → thumbnail pixel dissolve) plays,
 * honoring `prefers-reduced-motion` and the animations toggle/intensity
 * from Settings. Falls back to an instant patch if the entry is gone.
 */
function applyStreamedResult(result: StreamedResult): void {
  const entry = seen.get(result.videoId);
  if (!entry) return;

  // Validate the tier before rendering anything.
  const tier = VALID_STAMP_TIERS.includes(result.stamp as StampTier)
    ? (result.stamp as StampTier)
    : StampTier.UNSURE;

  // Render the badge first so animateStampPop can animate a real element.
  applyStamp(entry.stampHost, {
    stamp: tier,
    stampExplanation: result.stampExplanation,
  });

  uiApplyResult(entry.titleEl, {
    videoId: result.videoId,
    title: result.rewrittenTitle,
    stampEl: entry.stampHost.firstElementChild as HTMLElement | undefined,
    timing: result.timing ?? { inferenceMs: 0, cached: false },
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

  // Hide if the master toggle is off or this tier is disabled.
  const cfg = currentSettings;
  if (cfg && (!cfg.stamps.visible || !cfg.stamps.tiers[result.stamp])) {
    host.style.display = "none";
    return;
  }
  host.style.display = "";

  const badge = buildBadge(result.stamp, result.stampExplanation);
  host.appendChild(badge);

  // Attach tooltip
  attachTooltip(host, result.stampExplanation, { offsetX: 8, offsetY: 8 });
}

void main();
