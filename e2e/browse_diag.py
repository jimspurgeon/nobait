"""
Diagnostic: load real YouTube with the built extension, then report what
the natural (non-relay) pipeline actually did:

  - .nobait-stamp-host count      (content script title scan ran?)
  - img[data-nobait-thumb] count  (thumbnail pipeline ran?)
  - swapped src being blob: URLs  (actual frame injection?)
  - GET_PROVIDER_STATUS           (which backend got selected?)
  - watch-page title rewrite state after navigation

Run:  python e2e/browse_diag.py   (from repo root, after build)
"""
import json
import os
import sys
import time

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

GECKODRIVER = os.path.expanduser(
    "~/.cache/selenium/geckodriver/win64/0.37.1/geckodriver.exe"
)
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EXT_DIR = os.path.join(REPO, "dist", "firefox")

RELAY_JS = """
const detail = arguments[0];
const done = arguments[arguments.length - 1];
const html = document.documentElement;
html.removeAttribute("data-nobait-e2e-result");
const started = Date.now();
const timer = setInterval(() => {
  const raw = html.getAttribute("data-nobait-e2e-result");
  if (raw !== null) {
    clearInterval(timer);
    done(raw);
  } else if (Date.now() - started > 60000) {
    clearInterval(timer);
    done('{"success": false, "error": "relay response timeout"}');
  }
}, 250);
window.dispatchEvent(new CustomEvent("nobait:e2e", { detail }));
"""

PROBE_JS = """
return JSON.stringify({
  url: location.href,
  stampHosts: document.querySelectorAll(".nobait-stamp-host").length,
  badgeIcons: document.querySelectorAll(".nobait-stamp-host svg").length,
  titleCandidates: document.querySelectorAll("#video-title").length,
  thumbMarked: document.querySelectorAll('img[data-nobait-thumb="1"]').length,
  thumbBlobSrc: [...document.querySelectorAll('img[data-nobait-thumb="1"]')]
    .filter(i => (i.src||"").startsWith("blob:")).length,
  gridItems: document.querySelectorAll(
    "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer").length,
});
"""


CONSENT_JS = """
// Dismiss YouTube's EU consent wall if present. Buttons: the dialog under
// <tp-yt-paper-dialog> or the full-page consent screen; try common
// accept/reject selectors, preferring "Reject all" (safer, no cookies).
const sels = [
  'button[aria-label*="Reject"]',
  'button[aria-label*="reject"]',
  'tp-yt-paper-button[aria-label*="Reject"]',
  'button[aria-label*="Accept"]',
];
for (const sel of sels) {
  const btn = document.querySelector(sel);
  if (btn) { btn.click(); return "clicked:" + sel; }
}
const dlg = document.querySelector("tp-yt-paper-dialog");
return dlg ? "dialog-present-no-button" : "no-dialog";
"""


def log(msg):
    print(f"[diag] {msg}", flush=True)


def main():
    opts = Options()
    opts.add_argument("-headless")
    driver = webdriver.Firefox(service=Service(GECKODRIVER), options=opts)
    try:
        driver.install_addon(EXT_DIR, temporary=True)
        log("add-on installed")
        driver.set_script_timeout(90)

        driver.get("https://www.youtube.com")
        time.sleep(5)
        c = driver.execute_script(CONSENT_JS)
        log(f"consent: {c}")
        time.sleep(5)

        r = driver.execute_script(PROBE_JS)
        log(f"home-after-10s: {r}")

        # Which backend did the background pick with DEFAULT settings?
        st = json.loads(driver.execute_async_script(RELAY_JS,
                     {"message": {"type": "GET_PROVIDER_STATUS"}}))
        log(f"provider-status: {st}")

        ws = json.loads(driver.execute_async_script(RELAY_JS,
                     {"message": {"type": "GET_WASM_STATUS"}}))
        log(f"wasm-status: {ws}")

        ev = json.loads(driver.execute_async_script(RELAY_JS, {
            "message": {
                "type": "EVALUATE_VIDEO",
                "videoId": "diag1111111",
                "title": "SHOCKING secret they don't want you to know",
                "description": "A person cooks a pasta dish.",
            }}))
        log(f"evaluate: {ev}")

        time.sleep(20)
        r = driver.execute_script(PROBE_JS)
        log(f"home-after-evaluate: {r}")
        return 0
    finally:
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
