# Gatekeeper Audit Report

**Branch**: `jimspurgeon/nobait-gatekeeper`  
**Merge Target**: `master` (commit `1aa62b2`)  
**Audit Date**: 2026-10-08  
**Auditor**: Gatekeeper Worker  

## Executive Summary

This audit evaluated the merged 6-phase nobait implementation against 8 gate criteria defined in AGENTS.md. The codebase demonstrates strong architectural discipline and Firefox-first thinking, but fails 4 critical gate criteria that must be remediated before production release.

**Overall Verdict: GATE FAILED**

| Criterion | Status | Severity |
|-----------|--------|----------|
| Architecture conformance | **FAIL** | HIGH |
| TypeScript strict mode | PASS | - |
| Firefox-first portability | **FAIL** | CRITICAL |
| Privacy | PASS | - |
| Security | **FAIL** | HIGH |
| Accessibility | **FAIL** | MEDIUM |
| Test quality | PASS | - |
| Commit hygiene | PASS | - |

---

## Detailed Findings

### 1. Architecture Conformance ❌ FAIL

**Evidence:**

1. **Modules exceeding 200 lines** (AGENTS.md: "modules <200 lines"):
   - `src/content/ui.ts`: **666 lines** (violates modularization principle)
   - `src/ai/gemini.ts`: **526 lines**
   - `src/background/factcheck.test.ts`: **347 lines** (test file bloat)
   - `src/ai/classify.ts`: **294 lines**
   - `src/__tests__/ai/gemini.test.ts`: **293 lines**
   - `src/__tests__/ai/ollama.test.ts`: **288 lines**
   - `src/__tests__/ai/nano.test.ts`: **278 lines**
   - `src/background/scheduler.ts`: **274 lines**
   - `src/storage/cache.ts`: **271 lines**
   - `src/ai/nano.ts`: **270 lines**
   - `src/content/index.ts`: **252 lines**
   - `src/thumbnail/storyboard.ts`: **241 lines**
   - `src/thumbnail/pixelate.ts`: **240 lines**
   - `src/background/factcheck-client.ts`: **240 lines**
   - `src/background/factcheck-client.test.ts`: **239 lines**
   - `src/background/index.ts`: **238 lines**
   - `src/background/factcheck.ts`: **231 lines**
   - `src/__tests__/content/ui.test.ts`: **227 lines**
   - `src/background/factcheck-trigger.ts`: **221 lines**
   - `src/thumbnail/index.ts`: **215 lines**
   - `src/ai/factory.ts`: **215 lines**
   - `src/ai/ollama.ts`: **209 lines**

   **Total**: 23 of 57 production/test files exceed 200 lines threshold.

2. **Missing JSDoc on public exports**:
   - `src/background/scheduler.ts`: `EvaluationScheduler` class lacks full JSDoc for public methods like `close()`
   - `src/content/engine.ts`: Exported animation utilities lack JSDoc
   - `src/content/dom.ts`: `closestWithAttribute()` function has minimal documentation
   - `src/storage/cache.ts`: Public interface methods mostly undocumented

3. **File layout deviation from canonical structure**:
   - Missing: `src/manifest.json` is present but `public/stamp-icons/` directory does not exist despite being referenced in manifest
   - `src/background/factcheck-*` files cluster violates the flat module structure recommended in AGENTS.md
   - `src/settings/` directory introduced without mention in AGENTS.md canonical layout

---

### 2. TypeScript Strict Mode ✅ PASS

**Evidence:**

- `tsc --noEmit` produces **zero errors** across the entire codebase
- No `any` types in exported signatures (acceptable uses confined to:
  - Declaration files for browser globals (`declare const browser: any`)
  - Internal message handling where WebExtension API types are loose
  - Test mocks using `any` for flexibility
- Non-null assertions (`!`) limited to:
  - Context API calls where DOM guarantees existence (e.g., `getContext("2d")!`)
  - Array indexing after explicit length/type guards
  - 15 occurrences found, all defensible with inline reasoning

**Assessment**: Strict mode discipline maintained.

---

### 3. Firefox-first Portability ❌ FAIL

**Evidence:**

1. **Async listener `sendResponse` bug — background message handler** (CRITICAL):
   - `src/background/index.ts:43-76`: The message handler returns `true` for async response while invoking `.then(sendResponse)`:
     ```typescript
     const handleMessage = (
       message: { type?: string; [key: string]: any },
       _sender: unknown,
       sendResponse: (response: any) => void,
     ): boolean => {
       switch (message.type) {
         case "EVALUATE_VIDEO": {
           this.handleEvaluateVideo({...})
             .then(sendResponse)
             .catch((err) =>
               sendResponse({ success: false, error: String(err) }),
             );
           return true; // Async response
         }
     ```
   - This pattern (returning `true` + calling `sendResponse` after the promise resolves) is technically valid on Chrome's callback API. However, per MDN ([runtime.onMessage docs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage), [Bug 1877223](https://bugzilla.mozilla.org/show_bug.cgi?id=1877223)), when invoked via Firefox's promise-based `browser.runtime.onMessage` with wrappedJSObject/firefox strict semantics, the mix is fragile: in Firefox, when a listener registered via `browser.runtime.onMessage` returns `true`, the `sendResponse` callback semantics differ from Chrome's, and the safe pattern is returning a `Promise` instead.
   - **Compounding mismatch**: `src/utils/messages.ts` (content side) calls `browser.runtime.sendMessage(message)` expecting a **resolved value** (`await browser.runtime.sendMessage(...)` returns the response directly), but `src/background/index.ts` responds via the `sendResponse` **callback** style with `return true`. On Firefox, `browser.runtime.sendMessage` resolves with the value returned by the listener (or its Promise), NOT the value passed to `sendResponse` — meaning responses sent via `sendResponse` after `return true` may never reach the awaiting content script.
   - **Impact**: `processTitle()` in `src/content/index.ts` calls `sendToBackground({type:"EVALUATE_VIDEO",...})` and checks `response.success && response.data?.result` — if the response never resolves with the expected shape, stamps never render on Firefox. This is a latent **critical runtime failure** requiring a real Firefox E2E test to confirm severity.

2. **Chrome API usage without adequate feature detection**:
   - `src/background/index.ts:103-112`:
     ```typescript
     : typeof chrome !== "undefined" && chrome?.runtime?.onMessage
       ? chrome.runtime
     ```
     Feature detection is present (good), but the pattern is duplicated across ~6 files with slightly different shapes instead of living in one shared shim (see item 4 below). No double registration occurs — each site picks one API — but the duplication invites drift between copies.

   - `src/content/index.ts:192-199`:
     ```typescript
     if (typeof browser !== "undefined") {
       browser.runtime.onMessage.addListener((message: any) => {...});
     } else if (typeof chrome !== "undefined") {
       chrome.runtime.onMessage.addListener((message: any) => {...});
     }
     ```
     This is better but still creates two listener registrations instead of unified feature detection.

   - `src/options/index.ts:25,37,110`: Direct `chrome.storage.local` and `chrome.runtime.sendMessage` calls without `browser` fallback wrapper.

   - `src/utils/messages.ts:63-76`: Similar pattern—feature detection present but branches remain divergent.

2. **Manifest validation**:
   - `browser_specific_settings.gecko.id` **present**: ✅ `"nobait@nobait.example"`
   - `strict_min_version`: `"115.0"` — acceptable
   - **Note**: Manifest declares MV3 with `background.scripts` (event page). This is the correct Firefox-native form — Firefox MV3 does not use Chrome's `service_worker` key. If a Chrome build is ever produced, a manifest transform must swap in `service_worker`, but for the Firefox-first target this is **valid**.

3. **Background timers**: `src/background/index.ts` uses `setInterval()` in the background context. Under Firefox MV3 event pages this works, but the interval will not survive event-page suspension; cache cleanup becomes opportunistic rather than guaranteed. Minor reliability concern, not a blocker.

4. **`declare const browser: any; declare const chrome: any;`** (`src/background/index.ts:8-9`, `src/content/index.ts:17-18`): both globals are typed `any`, defeating type safety at the extension-API boundary and requiring repeated manual feature-detection. A typed shim (e.g., `webextension-polyfill` or ambient `@types/webextension-polyfill` declarations) would centralize this — currently there are ~6 near-duplicate detection blocks across `background/index.ts`, `content/index.ts`, `options/index.ts`, `utils/messages.ts`, `content/settings.ts`, and `ai/gemini.ts`, violating DRY and the "keep it in one file" spirit of the selector-isolation rule.

---

### 4. Privacy ✅ PASS

**Evidence:**

- **No telemetry**: Zero analytics calls, zero tracking pixels, no remote configuration endpoints
- **API key storage**: All providers (`GeminiProvider`, `OllamaProvider`) persist keys exclusively via `browser.storage.local`
- **No hardcoded secrets**: Git history shows `efb0e5b` removed the hardcoded InnerTube key; current runtime extraction via `ytcfg.get('INNERTUBE_API_KEY')` is secure
- **No user data egress** except to explicitly configured AI backends (Gemini/Ollama)
- **No key logging**: Verified via grep — no `console.log` statements expose API keys

**Assessment**: Privacy-first design implemented correctly.

---

### 5. Security ❌ FAIL

**Evidence:**

1. **Input sanitization gaps**:
   - `src/ai/classify.ts:sanitize()` handles control characters and truncation adequately
   - **Gap**: YouTube DOM data extracted in `src/content/signals.ts` and `src/content/dom.ts` is passed through `sendToBackground()` without explicit HTML entity escaping before transmission to AI backends
   - While `sanitize()` is called downstream, the raw extraction at `src/content/dom.ts:extractCard()` and `signals.ts` does not validate against XSS injection vectors

2. **AI backend URL validation**:
   - `src/ai/ollama.ts` accepts `baseUrl` from user config but **does not validate protocol/host constraints**
   - User could configure arbitrary endpoints including internal network addresses (SSRF vulnerability)
   - Missing: URL parsing + scheme validation (`http://` or `https://` only) + host whitelist/blacklist option

3. **CSP verification**:
   - Manifest does not declare a `content_security_policy` key, relying on MV3 defaults (which forbid eval/unsafe-inline in Firefox MV3) — acceptable baseline
   - `src/options/index.html` loads its script via `<script type="module" src="./index.ts">` (line 58). This is NOT an inline script (src-based, external file) — however `src="./index.ts"` references a TypeScript file directly; this only works if the build step transpiles/copies it with the same filename and sets correct MIME type. The build (`build.config.mjs`) does NOT bundle/copy the options page (no entryPoint for `src/options/index.ts` was observed — only `content` and `background`), so the shipped options page may 404 its script entirely.
   - No evidence of `eval()` or `Function()` constructors in production code; `innerHTML = ""` usages clear content rather than inject unsanitized markup

4. **Hardcoded secret residue**:
   - Git history contains hardcoded InnerTube API key `AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8` in commit `0471bcd`, later removed by `efb0e5b`
   - **Assessment**: Acceptable — secret was in development commit, properly remediated before merge

**Remediation Priority**: HIGH — SSRF via misconfigured Ollama URL poses network risk; missing options-page build breaks first-run UX for every user who opens settings.

5. **Options page not built/packaged** (BUILD GAP):
   - `src/manifest.json` declares `"options_ui": { "page": "assets/options.html" }`, but `build.config.mjs` has NO entry point for `src/options/index.ts` (only `content` and `background`) and performs NO `assets/` copy. The build output (`dist/firefox/`) contains **no `assets/options.html`**.
   - Consequence: `about:addons` → Preferences in Firefox opens a dead page; users cannot configure the Gemini key or any setting, leaving the extension in "no provider" mode with only a console warning.
   - Even unbuilt, the HTML references `src="./index.ts"` (raw TypeScript), which could never execute in the browser as-is.

---

### 6. Accessibility ❌ FAIL

**Evidence:**

1. **Color-only differentiation**:
   - `src/stamps/badges.ts` defines stamp tiers with both **glyph** AND **color**:
     - LEGITIMATE: ✓ + green (#1a7f37)
     - EXAGGERATED: ! + yellow (#b58900)
     - MISLEADING: ✗ + red (#cf222e)
     - CLICKBAIT: 🎣 + orange (#d1850f)
     - FAKE: ☠ + dark-red (#8b1d24)
     - UNSURE: ? + gray (#6e7781)
   - **PASS**: Distinct glyphs per tier ensure color-blind accessibility

2. **Contrast verification** (computed WCAG ratios, white glyph on colored circle):
   - Green (#1a7f37): 5.08:1 — **passes** AA (≥4.5:1)
   - Yellow (#b58900): 3.21:1 — **fails** AA for normal-size text (4.5:1 required)
   - Red (#cf222e): 5.36:1 — **passes**
   - Orange (#d1850f): 2.97:1 — **fails** AA (and only marginally meets the 3:1 non-text minimum of WCAG 1.4.11)
   - Dark-red (#8b1d24): 9.13:1 — **passes**
   - Gray (#6e7781): 4.55:1 — **passes** (barely)
   - The badge glyph is 12px SVG text on a 14px badge — below the 18pt/14pt-bold "large text" threshold, so 4.5:1 applies. Two tiers (EXAGGERATED, CLICKBAIT) fail in both themes (the badge circle color is theme-independent).

3. **Keyboard accessibility**:
   - Tooltips in `src/stamps/tooltips.ts` triggered only via mouse events (`mouseenter`/`mouseleave`)
   - **No keyboard focus handlers** for badge elements
   - Badges lack `tabindex` attributes, making them inaccessible to keyboard-only users
   - Hover-dependent explanations are **non-essential per AGENTS.md** but should still support `focus` events for completeness

**Remediation Priority**: MEDIUM — Visual contrast failures impact readability; keyboard gaps affect assistive technology users.

---

### 7. Test Quality ✅ PASS

**Evidence:**

- **267 tests pass** across 23 test files
- **Vacuous test patterns checked**:
  - No `expect(true)` assertions found
  - All test files contain substantive `expect()` calls (minimum 4 assertions per test file)
  - `src/__tests__/stamps/types.test.ts`: 4 tests, 11 expect calls — appropriate scope
  - `src/__tests__/content/nav.test.ts`: 4 tests, 4 expect calls — focused on specific behaviors

- **Mocking discipline**:
  - `src/__tests__/ai/scheduler.test.ts` heavily mocks but validates **observable behaviors** (coalescing timing, deduplication, callback delivery)
  - `src/__tests__/content/ui.test.ts` asserts animation timing budgets and DOM mutation counts, not mock internals

- **Edge case coverage**:
  - `src/__tests__/ai/classify.test.ts`: Validates parse failure → UNSURE fallback
  - `src/background/factcheck-corroborate.test.ts`: Tests malformed API responses
  - `src/background/factcheck-trigger.test.ts`: Tests heuristic triggers

**Assessment**: Test suite exercises real behaviors, not just mocks.

---

### 8. Commit Hygiene ✅ PASS

**Evidence:**

- **Conventional commits verified**:
  - `feat(integration): wire P6 fact-check layer`
  - `fix(security): remove hardcoded InnerTube key`
  - `chore:integration): reconcile p2 code`
  - `refactor(integration): adapt P3 runtime`

- **Secrets in history**: Only the InnerTube API key mentioned above, properly removed before merge to master

- **LICENSE intact**: AGPL-3.0 present and unmodified

- **No breaking-change commits without migration notes**: All merges follow standard integration flow

**Assessment**: Git history clean and professional.

---

## Remediation Checklist

### Critical Priority (Blockers)

- [ ] **Fix the background message-handler response pattern**: Verify (via real Firefox E2E) that `sendResponse`-after-`return true` reliably delivers responses to `browser.runtime.sendMessage` awaiters on Firefox; if not, refactor `src/background/index.ts` to return Promises from the listener. This is the highest-risk item — the whole stamp pipeline depends on it.
- [ ] **Consolidate Chrome/browser API usage**: Introduce one typed API shim module; remove the ~6 scattered feature-detection blocks and duplicate listener registrations (`background/index.ts`, `content/index.ts`, `options/index.ts`, `utils/messages.ts`, `content/settings.ts`, `ai/gemini.ts`).

### High Priority

- [ ] **Build and package the options page**: Add `src/options/index.ts` as a build entry point and copy `index.html`/`styles.css` to `dist/firefox/assets/`. Without this the settings UI 404s and no provider can ever be configured.
- [ ] **Verify/fix the background message-handler response pattern on Firefox**: Convert the `handleMessage` switch to return a `Promise` (Firefox-native) and test with a real `browser.runtime.sendMessage` round-trip. The current `return true` + async `sendResponse` callback pattern is Chrome-callback style and is unreliable under Firefox promise-based messaging.
- [ ] **Reduce module sizes**: Split files exceeding 200 lines (especially `ui.ts`, `gemini.ts`, `scheduler.ts`)
- [ ] **Add JSDoc to public exports**: Document all exported classes, interfaces, and functions
- [ ] **Validate AI backend URLs**: Add URL parsing and protocol/host restrictions to Ollama provider
- [ ] **Implement input sanitization at DOM boundary**: Escape HTML entities before transmitting to AI backends

### Medium Priority

- [ ] **Fix color contrast for EXAGGERATED and CLICKBAIT stamps**: Current white-on-yellow (3.21:1) and white-on-orange (2.97:1) fail WCAG AA 4.5:1. Darken circle fills (e.g., amber ~#8a6d00-class, burnt orange ~#9a5b0a-class) or use dark glyphs on light fills.
- [ ] **Add keyboard support to tooltips**: Implement `focus`/`blur` handlers and `tabindex` on badge elements
- [ ] **stamp-icons asset directory**: `public/stamp-icons/` from the canonical AGENTS.md layout does not exist. Stamps are inline SVG (compliant with "no external images" rule), so this is harmless — but the canonical layout vs. reality divergence should be reconciled (update AGENTS.md or add assets).

---

## Recommendations for Human Review

1. **Performance testing**: The 267-unit-test suite does not capture real-world latency or memory behavior. Recommend running E2E tests (`npm run test:e2e`) on actual Firefox builds with live YouTube traffic.

2. **CSP policy**: Explicitly define a `content_security_policy` in manifest.json before production release, even if currently relying on defaults.

3. **Test coverage gaps**: No tests cover:
   - Actual storyboard sprite math calculations
   - Real InnerTube API responses
   - Multi-tab coordination behavior

4. **Options page**: Verify all settings persist correctly across browser restarts; no automated tests exercise storage round-trips.

---

**Audit Complete.** The codebase demonstrates competent engineering but requires critical Firefox compatibility fixes before production deployment.
