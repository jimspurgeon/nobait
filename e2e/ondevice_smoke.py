"""
E2E smoke: real nobait build + real wllama + real model download.

Loads dist/firefox as a temporary add-on, forces the builtin WASM backend
with the small SmolLM2-135M-Instruct model through the content-script relay
(window CustomEvent "nobait:e2e"), then drives one EVALUATE_VIDEO round
trip and asserts the result comes from real inference, not the error
fallback.

Run:  python e2e/ondevice_smoke.py   (from the repo root, after build)
"""
import json
import os
import sys
import time
import glob

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
// Content-script CustomEvent details are Xray-opaque to WebDriver's
// privileged world, so the relay also mirrors the response into the
// `data-nobait-e2e-result` attribute on <html>; poll that.
const html = document.documentElement;
html.removeAttribute("data-nobait-e2e-result");
const started = Date.now();
const timer = setInterval(() => {
  const raw = html.getAttribute("data-nobait-e2e-result");
  if (raw !== null) {
    clearInterval(timer);
    done(raw);
  } else if (Date.now() - started > 240000) {
    clearInterval(timer);
    done('{"success": false, "error": "relay response timeout"}');
  }
}, 250);
window.dispatchEvent(new CustomEvent("nobait:e2e", { detail }));
"""


def log(msg):
    print(f"[smoke] {msg}", flush=True)


def main():
    opts = Options()
    opts.add_argument("-headless")
    driver = webdriver.Firefox(service=Service(GECKODRIVER), options=opts)
    try:
        driver.install_addon(EXT_DIR, temporary=True)
        log("add-on installed")

        driver.get("https://www.youtube.com")
        time.sleep(4)  # content script boot + background factory init
        driver.set_script_timeout(300)

        def relay(detail, timeout_note=""):
            r = driver.execute_async_script(RELAY_JS, detail)
            log(f"{timeout_note}{r}")
            return json.loads(r)

        # 1) Sanity: background responds.
        st = relay({"message": {"type": "GET_PROVIDER_STATUS"}}, "status: ")
        if not st.get("success"):
            log("FAIL: background did not respond")
            return 1

        # 2) Pin builtin backend + SmolLM2-135M, wait for re-init.
        relay(
            {"setSettings": {"ai": {"backend": "builtin", "builtinModel": "smollm2-135m"}}},
            "settings: ",
        )
        time.sleep(3)

        # 3) One real inference round trip (downloads ~88 MB on first run).
        r = relay(
            {
                "message": {
                    "type": "EVALUATE_VIDEO",
                    "videoId": "smoke1",
                    "title": "You WON'T BELIEVE what happens next!!",
                    "description": "A man repairs a bicycle wheel in his garage.",
                }
            },
            "evaluate: ",
        )
        err = str(r.get("error", ""))
        if "JSPI" in err or "memory64" in err or "Firefox" in err:
            log(f"SKIP: browser lacks wasm features: {err}")
            return 0
        if r.get("success") is False:
            log(f"FAIL: {err}")
            return 1
        res = r.get("result") or r.get("data") or {}
        explanation = str(res.get("stampExplanation", ""))
        if "WASM provider error" in explanation:
            log(f"FAIL: result came from the error fallback: {explanation}")
            return 1
        log(f"PASS: builtin wasm round trip -> stamp={res.get('stamp')} title={res.get('rewrittenTitle')!r}")
        return 0
    finally:
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
