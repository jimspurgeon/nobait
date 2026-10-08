/**
 * nobait — YouTube content script entry.
 *
 * Runs at `document_start` (manifest) and survives SPA navigations thanks to
 * the NavWatcher. The script detects any YouTube video IDs present in the DOM
 * and logs them to the console. No other patching happens in this skeleton;
 * later phases inject titles/thumbnails/stamps here.
 */
import { isYouTubeHost } from "../utils/url";
import { createNavWatcher } from "./nav";
import { findVideoHits } from "./dom";

const log = (...args: unknown[]): void => console.log("[nobait]", ...args);

if (isYouTubeHost(location.host)) {
  main();
}

function main(): void {
  log("Content script loaded on", location.href);

  const watcher = createNavWatcher();

  let batchTimer: number | undefined;
  const flushBatch = () => {
    batchTimer = undefined;
    for (const hit of findVideoHits(document)) {
      log(`Found video: ${hit.videoId}`);
    }
  };

  const scheduleFlush = () => {
    if (batchTimer !== undefined) return;
    batchTimer = self.setTimeout(flushBatch, 50) as unknown as number;
  };

  // React to the initial DOM being ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleFlush, {
      once: true,
    });
  } else {
    scheduleFlush();
  }

  // React to DOM changes (YouTube SPA inserts nodes constantly).
  const obs = new MutationObserver(scheduleFlush);
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // React to SPA navigations.
  watcher.onNavigate((href) => {
    log("Navigated to", href);
    scheduleFlush();
  });

  log("Observing YouTube SPA for video IDs...");
}
