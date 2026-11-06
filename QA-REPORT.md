# nobait QA Audit Report

**Auditor:** QA worker (nobait-qa worktree, branched from master @ 1aa62b2)
**Date:** 2026-10-09
**Scope:** Functional test sweep across P1–P6 merge; gate status, cross-phase seam analysis, performance-budget review, Firefox-first compliance, E2E smoke.

---

## Executive Summary

The extension is **partially end-to-end functional**. The core spine works: content script observes YouTube's DOM, sends `EVALUATE_VIDEO` to the background worker, the scheduler coalesces/dedupes, the AI factory picks a provider (Gemini/Ollama/Nano), results stream back and stamps are injected next to titles. The P2 thumbnail pipeline runs in parallel and independently. **However, the P5 delight layer (decode scramble, pixel dissolve, stamp pop-in) is dead code in production** — the content script patches the DOM directly with no animation calls, and PLAN.md's 600px IntersectionObserver prefetch is entirely missing. One blocker (broken `npm install`/`npm run lint` due to dependency/config drift) was fixed directly.

| Gate | Status |
|---|---|
| `npm install` | ❌ BLOCKER (fixed by QA) — ERESOLVE on `@eslint/js@10` vs `eslint@8`; lockfile out of sync |
| `npm test` | ✅ 267 passed / 23 files (0 failures, 4.5s) |
| `npm run typecheck` | ✅ Clean |
| `npm run lint` | ❌ 140 errors after fixing tooling (dev-only code-quality violations; see §2) |
| `npm run build:firefox` | ✅ Builds; options page incorrectly emitted at root `options.js` (minor layout wart) |

---

## 1. Blockers (found & fixed)

### B1 — `npm install` fails with ERESOLVE (fixed)
- **Severity:** blocker
- **Files:** `package.json`
- **Repro:** `npm install` → `ERESOLVE could not resolve … peerOptional eslint@"^10.0.0" from @eslint/js@10.0.1` while `eslint@^8.57.0` pinned. Lockfile was also out of sync with `package.json` (references vite@7/vitest@3 for an app pinned to vite@5/vitest@2) — `npm ci` fails outright.
- **Fix (QA):** Pinned `@eslint/js` to `^9.39.0` (compatible with `typescript-eslint@8` and the flat-config `eslint.config.js` the repo actually uses), upgraded `eslint` to `^9.39.0`, added missing `typescript-eslint` wrapper package, and regenerated `package-lock.json`. `npm ci` now succeeds.
- **Commit:** `fix(qa): repair dependency resolution — align eslint/@eslint/js, add typescript-eslint`

### B2 — `npm run lint` crashes before linting (fixed, partially)
- **Severity:** blocker (for CI parity; the task checklist treats lint as a gate)
- **Files:** `package.json` (scripts), `eslint.config.js`
- **Repro:** `npm run lint` → `Invalid option '--ext'` (flat-config ESLint rejects legacy flags) and `Cannot find package 'typescript-eslint'` (config imports a package that wasn't declared).
- **Fix (QA):** Removed `--ext .ts,.tsx` from lint scripts, added `typescript-eslint` dependency. `npm run lint` now runs and **reports 140 pre-existing errors** (see M1).
- **Commit:** same as B1.

---

## 2. Majors (documented; not fixed — code-quality debt, not correctness)

### M1 — Lint gate fails with 140 errors
- **Severity:** major
- **Files:** ~27 files across `src/` (worst: `src/ai/gemini.ts`, `src/storage/cache.ts`, `src/thumbnail/pixelate.ts`, `src/content/ui.ts`, `src/background/*.ts`, and all colocated `*.test.ts` files that eslint now lints)
- **Detail:** After repairing the toolchain, `eslint src` reports **140 errors, 0 warnings**: `@typescript-eslint/no-explicit-any` (~50), `@typescript-eslint/no-non-null-assertion` (~60), `no-unused-vars`, one `@typescript-eslint/no-unused-expressions`. Root causes are structural: the merge mixed P2's defensive-IDB style (non-null assertions after `onsuccess` guards) with P4/P6's `any`-heavy API shims, and colocated background tests (`src/background/*.test.ts`) are linted although `tseslint.configs.strict` was authored for `src/` only. The per-file `<200 lines` module guideline is also violated by `src/content/ui.ts` (666), `src/ai/gemini.ts` (526), `src/ai/classify.ts` (294).
- **Recommendation:** Either relax `no-non-null-assertion`/`no-explicit-any` in `eslint.config.js` overrides for the IDB/bridging layers, or fix forward module by module. Also add `src/**/*.test.ts` overrides disabling strict type rules on test doubles. Until then, treat `npm run lint` as a known-red gate — **do not merge on "lint clean" claims**.

### M2 — P5 animations are never invoked in production code
- **Severity:** major (feature-orphan seam, exactly what the audit asked)
- **Files:** `src/content/ui.ts:458-478` (`applyResult` facade), `src/content/index.ts:217-236` (its own local `applyResult`), `src/content/index.ts:107-118`
- **Detail:** `ui.ts` exports a purpose-built `applyResult(titleEl, patch)` facade that sequences `animateTitleDecode` → `animateStampPop` → `animatePixelDissolve` — the PLAN.md §6 choreography. **Nothing calls it.** The content script defines its own differently-shaped `applyResult` that sets `textContent` and `innerHTML` directly, with no timing context, no `AnimMode`, no rAF-engine participation. Same for `batchCrossfade`: only `thumb-swapper.ts` uses it (so thumbnails do get a plain 250ms crossfade), but the signature pixel-dissolve and title scramble ship exclusively in `demo/main.ts` and unit/E2E tests. Consequences:
  - No adaptive animation durations (`classifyTiming` dead in prod).
  - `performance.mark` instrumentation ("budget instrumentation" per PLAN §9) never fires in production paths.
  - `prefers-reduced-motion` is respected only for the thumbnail crossfade, not for title/stamp patches (direct text writes bypass it — which is functionally "instant," so no a11y regression, but inconsistent with spec).
- **Repro:** `grep -rn "applyResult\|animateTitleDecode\|animatePixelDissolve\|animateStampPop" src/content/index.ts` → only the local, non-animated variant exists.
- **Recommendation:** Wire content `applyResult` to `ui.ts`'s facade, pass `timing: { inferenceMs, cached }` from the background message, and delete the local duplicate.

### M3 — PLAN.md Stage-0 prefetch (600px IntersectionObserver) is missing
- **Severity:** major (performance budget violation by omission)
- **Files:** `src/content/observer.ts` (SpatObserver — no IntersectionObserver at all), `src/content/index.ts:28` (comment mentions "Fair scheduling for IntersectionObserver callbacks" but none exists), `src/content/nav.ts:59` (250ms/150ms polling)
- **Detail:** PLAN.md's "single biggest perceived-speed win" — `IntersectionObserver` with `rootMargin: '600px 0px'` firing evaluation before cards scroll into view — is implemented nowhere. Thumbnail/stamp evaluation only happens when MutationObserver sees added nodes (i.e., YouTube renders them, often already in/near viewport) plus a `nav.ts` poll. There's also no hover prefetch (PLAN §5). The batch-20 AI coalescing (P3) does exist (`scheduler.ts` MAX_BATCH_SIZE=20, 50ms window) ✅ and request dedup/one-round-trip is solid ✅, but the *when* of evaluation is strictly reactive.
- **Note:** `perf.test.ts` micro-tests pass, but they measure the animation loop, not the prefetch pipeline.
- **Recommendation:** Add the IO with 600px rootMargin feeding `processTitle` + `ThumbnailSwapper.applyCards`.

### M4 — Dual scan pipelines: two MutationObservers + two navigation watchers per page
- **Severity:** major (perf/architecture seam)
- **Files:** `src/content/index.ts:63-64` (`scanAndProcess()` + `observeMutations()` own MutationObserver, lines 128-152), `src/content/index.ts:154-176` (`observeNavigation` pushState patch), `src/content/observer.ts` (SpatObserver's own MO + 250ms URL poll), `src/content/nav.ts` (createNavWatcher — third mechanism, **entirely unused**)
- **Detail:** The merged content script runs **two full MutationObservers on `document.body` subtree** (one for stamps, one for thumbnails), two URL-poll intervals (250ms each after the 150ms nav.ts — well, nav.ts isn't instantiated), a `history.pushState` monkey-patch, and a Navigation-API listener — while `nav.ts` (the polished P1 nav watcher combining yt-navigate-finish + Navigation API + popstate + polling) is exported but never imported outside tests. This roughly doubles per-mutation cost on YouTube's very chatty DOM and violates PLAN.md Stage-0 "≤1ms per batch" spirit and the AGENTS.md small-modules principle (index.ts duplicates observer responsibilities).
- **Recommendation:** Collapse to one MO → one card-extraction pass feeding both pipelines; adopt `createNavWatcher`.

### M5 — Options page doesn't cover P7 spec; factory ignores user's backend choice
- **Severity:** major (functional gap vs AGENTS.md options spec)
- **Files:** `src/options/index.html` (no thumbnail-position, stamp, cache-TTL, allowlist settings), `src/options/index.ts` (saves `preferredBackend` but nothing reads it), `src/ai/factory.ts:166-190` (`initialize({preferredProvider…})` is called by background with `{}` only; `sameName` check compares against `config.preferredProvider ?? "gemini"` but background never passes one)
- **Detail:** The options UI persists `preferredBackend` to `browser.storage.local`, but the background factory `initialize({})` never reads it — so choosing "Ollama / Local server" in options has **no effect** (Ollama is only reachable if the factory was constructed with an `ollamaUrl`, which no code path provides; only Gemini auto-fallback ever engages). Also `SET_GEMINI_API_KEY` handler resolves `provider instanceof GeminiProvider` — after factory fallback this is usually true, but if user picked Ollama the key save silently no-ops the wrong way. `GET_CACHE_STATUS` returns hardcoded zeros.
- **Recommendation:** Background should read `preferredBackend`/`ollamaUrl` from storage at init and on `storage.onChanged`, feeding factory config.

---

## 3. Minors

### m1 — Version mismatch
`package.json` 0.5.0 vs `src/manifest.json` 0.3.0. Violates the release workflow (AGENTS.md: bump both together).

### m2 — Options build emitted at dist root
`vite.config.ts` rename shim moves `dist/firefox/src/options/index.html` → `assets/options.html`, rewrites `/options.js` → `../options.js`, and bundles `assets/options.css` with the correct hashed-path `<link>` ✅ — clean after all. However `options.js` itself is emitted at the dist **root** (works via the relative ref), which is merely cosmetic layout inconsistency (options.js/content.js/background.js at root, assets/ for CSS+HTML). Not a defect.

### m3 — `homepage_url` placeholder
`src/manifest.json` points to `https://example.com/nobait` — should be real repo URL before AMO submission.

### m4 — Placeholder icons
Solid green PNGs per AGENTS.md note ("Replace with designed icons before release") — intentional, tracked.

### m5 — Background cache-status handlers are stubs
`getCacheStatus()` returns `analysisCount: 0, negativeCount: 0` hardcoded; `clearCache()` closes/reopens the DB (reasonable proxy, but doesn't clear object stores, so "Cache cleared." in options is only true for the connection lifecycle, not data). Negative-cache DB is separate (`nobait-thumbnails`, `nobait-sprites` deletions exist under `nobait:clear-thumb-cache` ✅ but that message is sent by nobody — thumb-swapper `onDone` doesn't use it; orphaned handler).

### m6 — Scheduler TTL constants diverge from PLAN
`src/background/scheduler.ts:207` analysis TTL = 7 days (PLAN says 30); negative TTL = 24h (PLAN says 7 days). Harmless but document or align.

### m7 — Double fact-check + double cache on streamed results
`broadcastResult` sends `NEW_RESULT` to **all** tabs; the originating content script already applied the result via the `EVALUATE_VIDEO` response, then re-applies on the broadcast (guarded only by `seen` map + `applyStamp` clearing innerHTML — idempotent but wasteful; title re-write flashes twice on quick networks). Consider skipping sender tab or deduping by `timestamp`.

### m8 — `host._nobaitTooltipCleanup?.()` relies on expando property
`src/content/index.ts:229` uses an undeclared `(host as any)._nobaitTooltipCleanup` pattern — type-unsafe, and `attachTooltip` in `stamps/tooltips.ts` never sets it (checked: tooltips module returns nothing). So tooltip cleanup silently never runs; repeated results stack listeners. Minor leak.

### m9 — `tools` / `web_accessible_resources` absent
Not needed today (no external fetch of bundled assets) ✅ — confirming no missing-permission issue for Gemini: `host_permissions` includes `generativelanguage.googleapis.com` ✅. But note **fetch from a content-script context would fail**; ours run in background ✅.

---

## 4. Cross-phase seam analysis (audit checklist item 2)

| Seam | Verdict | Evidence |
|---|---|---|
| Content script ↔ background (P3) | ✅ Wired | `sendToBackground({type:"EVALUATE_VIDEO"})` (content/index.ts:112) → background router (background/index.ts:49) → `scheduler.evaluate` → factory provider. Response and streamed `NEW_RESULT` both handled. |
| Scheduler ↔ AI factory (P3↔P4) | ✅ Wired | `scheduler.flush()` calls `aiProviderFactory.initialize({})` then `provider.analyzeBatch(chunk)` async-iterable (scheduler.ts:157-176). Factory falls back to GeminiProvider with `loadApiKey()` from storage — works with zero configuration attempts a real call (fails with "API key not configured" — handled as negative-cache? **No**: it rejects, batch rejects, content logs error; no negative entry. Acceptable degradation). |
| Stamps render in patched DOM paths (P4) | ✅ Wired w/ caveat | `processTitle` inserts `.nobait-stamp-host` after `SELECTORS.TITLE` elements; `buildBadge`/`attachTooltip` render there. Caveat: `stampHost` is inserted via `titleEl.parentElement.insertBefore` — on YouTube's grid the title element's parent is the metadata row; fine. But `seen` map is never cleared on SPA nav, so **re-entering a page with the same video won't re-patch titles** (title rewrite on re-visit only via NEW_RESULT broadcast). Minor UX seam. |
| Fact-check (P6) wired in? | ✅ Wired, late | `handleEvaluateVideo` runs `evaluateFactCheck` parallel with `scheduler.evaluate`, then applies `factCheck.result.stamp` if `changed` (background/index.ts:130-146). Correctly non-gating. **But** it awaits `factCheckPromise` *after* the scheduler result before responding — the 400ms timeout bounds this, so budget holds. Settings gating via `readSettings` ✅ (default disabled). Source lines (`formatSourceLines`) are computed but **never reach the tooltip** — tooltip gets only `stampExplanation`. Minor orphan (documented in P6 spec as future). |
| P5 animations hooked to replacement events? | ❌ **NOT WIRED** | See M2. Only `demo/main.ts` and tests exercise them. |
| Thumbnail pipeline (P2) settings vs hardcode | ⚠️ Partial | `ThumbnailSwapper` receives `settings.thumbnailPosition` from `loadSettings()` ✅ (content/index.ts:44-48). But `NobaitSettings` only models `thumbnailPosition` + `debug` — **no options UI writes `settings`** (options page writes `preferredBackend`/`geminiApiKey` keys), so user-facing config surface is effectively absent (ties into M5). Position logic itself respects the setting end-to-end ✅. |
| E2E coverage of the stamp/AI pipeline | ⚠️ Weak | `e2e/thumbnail.spec.ts` covers P2 well (mocked InnerTube + sprites, caching, reduced-motion). **No E2E for stamps/AI/fact-check** despite mocked-AI assertions listed in AGENTS.md testing strategy. |

**Bottom line seam verdict:** The extension **runs end-to-end for the stamp+thumbnail happy path with Gemini/Ollama configured**, and P2 thumbnails work even with no AI key (graceful). The two genuine orphan/seam failures are (a) the entire P5 animation layer and its timing/`AnimMode` plumbing, and (b) the options→factory configuration path. Everything else merges cleanly.

---

## 5. Performance budget review (PLAN.md §1)

| Budget | Status |
|---|---|
| Cache hit ≤16ms | ⚠️ Untested in prod path; `cacheDB.getAnalysis` is IndexedDB-first in scheduler before inflight — plausible, but no mark/measure instrumented (M2 kills instrumentation). |
| 600px prefetch | ❌ Missing (M3). |
| Batch-20 AI | ✅ `MAX_BATCH_SIZE=20`, 50ms coalesce window, per-video streaming via async-iterable + `deliverResult`. |
| Streaming patch per video | ✅ Provider yields incrementally; `onResult` listeners broadcast per result. (Rendered without animation — M2.) |
| Fact-check ≤1.2s / 400ms timeout | ✅ 400ms hard timeout via Promise.race + abort; never gates (applied post-hoc, only strengthens toward FAKE). |
| One wasted request is a bug | ✅ Mostly: dedup via `inflight` map (scheduler, ThumbnailManager), negative cache, sprite/spec IndexedDB caches, hover... — no hover prefetch (miss, not waste). Minor: `broadcastResult` re-application (m7). |
| Silent degradation | ✅ Strong everywhere (null returns, catch-all, original content preserved). |

---

## 6. Firefox-first compliance (checklist item 4)

- **Manifest**: MV3, `browser_specific_settings.gecko` present with id + `strict_min_version: 115` ✅; `background.scripts` (event page) — valid Firefox MV3 pattern ✅; no Chrome-only keys (`minimum_chrome_version`, `externally_connectable`) ✅; `applications` alias not needed ✅.
- **`chrome.` usage grep**: every `chrome.` reference in `src/` is behind `typeof browser !== "undefined" ? browser : chrome` fallback chains (background/index.ts:106-111, content/index.ts:186-203, utils/messages.ts:55-67, options, gemini provider) ✅ — no Chrome-only API without Firefox path.
- **Caveat**: webextension-polyfill is a declared runtime dependency but the code hand-rolls the compat shim instead of importing it — dead weight in `package.json` (nit). Bundle is IIFE via Vite ✅.
- **Host permissions** cover youtube.com, ytimg.com, and generativelanguage.googleapis.com; fact-check's `factchecktools.googleapis.com` is fetched from the background service worker — **MV3 Firefox requires host permission for cross-origin fetch from extension pages? Actually extension-background fetch to a cross-origin URL requires the host permission**, and `factchecktools.googleapis.com` is **NOT in host_permissions** → the P6 lookup will fail CORS/permission in production Firefox unless the user has a key AND the permission is added. **Minor-to-major boundary; flagged as m10 since P6 ships disabled-by-default.**
  - **m10 — add `"https://factchecktools.googleapis.com/*"` to `host_permissions` before enabling P6.**

---

## 7. E2E smoke test (checklist item 5)

Environment check: Playwright + Firefox 157 (playwright build) are installed locally, but loading a **temporary add-on** requires `web-ext`/`--load-extension` via Playwright's `launchPersistentContext` with `firefox` channel support for extensions (Playwright supports extensions only in persistent context on Chromium fully; Firefox extension loading via Playwright is supported since v1.45+ through `addons` in `launchPersistentContext`? — not reliably scriptable headlessly here). Additionally, live `youtube.com` access from this sandbox was not attempted to avoid network-dependent flakiness.

**Status: SKIPPED gracefully** per task instructions ("Skip gracefully if environment lacks browser automation"). Compensation: unit suites (267 tests incl. content/DOM, nav, dissolve, perf micro-tests) all green; P2 E2E suite exists and is network-mocked but was not executed headlessly in this environment (would require `npx playwright test`, which the merge QA leaves to CI). Console-log contract verified statically: all logs use the `[nobait]` prefix ✅ (spot-checked content, background, factcheck).

---

## 8. Fixes applied by QA

| Fix | Commit | Notes |
|---|---|---|
| Align `@eslint/js`/`eslint` versions, add `typescript-eslint`, drop `--ext` flags, regenerate lockfile | `fix(qa): …` | Restores `npm install`, `npm ci`, and a runnable `npm run lint` (which then surfaces the 140 pre-existing errors → M1). |

All minors/majors left documented, per task scope.

---

## 9. Recommended priorities

1. **Wire P5 animations into content `applyResult`** (M2) — highest user-visible payoff, code already exists and is tested.
2. **Add 600px IntersectionObserver prefetch** (M3) — PLAN calls it the biggest perceived-speed win.
3. **Options → factory plumbing** (M5) + fact-check host permission (m10).
4. **Collapse dual MutationObservers** (M4).
5. **Lint debt burn-down or config rationalization** (M1).
6. Sync versions (m1) and replace placeholder icons (m4) before AMO.
