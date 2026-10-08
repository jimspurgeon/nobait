/**
 * nobait — background script (service worker) skeleton.
 *
 * In P1 it only logs startup. Later phases add the scheduler, cache,
 * AI orchestration, and thumbnail compositing here.
 */
console.log("[nobait] background started");

browser.runtime.onInstalled.addListener((details) => {
  console.log("[nobait] installed:", details.reason);
});
