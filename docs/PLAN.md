# nobait — Build Plan & Performance Architecture

This document is the definitive engineering plan for building nobait. It
exists because **speed is the product**: if title rewriting and stamping don't
feel near-instant, the extension fails. Everything below is designed around
that constraint.

---

## 1. Performance budget

The extension must feel invisible. Budget (measured from *element scrolled
into viewport* to *fully patched DOM*):

| Scenario | Budget | Achieved by |
|---|---|---|
| Cache hit (title + stamp + thumbnail) | ≤ 16 ms (one frame) | IndexedDB read, pre-composed blob URLs |
| Cache hit, thumbnail not yet composited | ≤ 100 ms | Pre-warmed cache in background, canvas crop |
| Cold, fast backend (Flash-Lite class) | ≤ 700 ms | Sub-second model, streaming patch |
| Cold, local Ollama | ≤ 2 s | Small quantized model |
| Cold, with fact-check lookup | ≤ 1.2 s (lookup races in parallel) | Strict 400 ms lookup timeout |
| Anything failing | degrade silently | Original title/thumbnail always preserved |

Hard rules:

1. **Never block or blank** the original content. The original title and
   thumbnail stay visible until the replacement is fully ready, then the swap
   animates.
2. **Main thread work in content script is minimal**: DOM observation,
   dispatch, and animation only. All network, inference orchestration,
   caching, and canvas cropping happen in the background service worker.
3. **One wasted request is a bug.** Deduplicate, coalesce, and memoize
   aggressively.

---

## 2. Architecture overview

```
┌─────────────────────────── youtube.com tab ───────────────────────────┐
│  content script (thin)                                                │
│  ├─ observer.ts      MutationObserver + nav events, batched (rAF)     │
│  ├─ dom.ts          selectors → VideoCard[] (id, nodes, inViewport)   │
│  ├─ ui.ts           animation engine (scramble/crossfade/pop-in)     │
│  └─ stamps.ts       stamp badge injection + tooltips                  │
└───────────────▲───────────────────────────────┬───────────────────────┘
        results │ (runtime.sendMessage)          │ requests (batched, prioritized)
┌───────────────┴───────────────────────────────▼───────────────────────┐
│  background service worker                                             │
│  ├─ scheduler        priority queue, viewport proximity, concurrency   │
│  ├─ signals          description/chapters/transcript fetch (InnerTube) │
│  ├─ ai/factory       provider selection, batch prompts, streaming      │
│  ├─ factcheck        ClaimReview lookups (FAKE-tier corroboration)     │
│  ├─ thumbnail        storyboard fetch, canvas crop, blob URL cache     │
│  └─ cache            IndexedDB: titles, stamps, sprites, negatives     │
└────────────────────────────────────────────────────────────────────────┘
```

**Why this split**: the content script would otherwise contend with YouTube's
own heavy main thread; the background worker survives SPA navigations and can
run fetches/inference regardless of tab state. Message payloads are kept tiny
(only IDs and results, never DOM nodes).

---

## 3. Evaluation pipeline (cold path)

For each newly observed video, in order:

### Stage 0 — Observe (content script, ≤ 1 ms per batch)
- `MutationObserver` callbacks are collected and flushed **once per animation
  frame** (coalesced), then mapped through `SELECTORS` to lightweight
  `VideoCard` descriptors.
- An `IntersectionObserver` with `rootMargin: '600px 0px'` fires evaluation
  for cards *before* they're visible — by the time the user scrolls, the
  result is often already cached. This is the single biggest perceived-speed
  win.

### Stage 1 — Cache check (background, ≤ 5 ms)
- Key: `videoId` (+ model/prompt version tag for invalidation).
- Hit → result dispatched immediately, thumbnail blob URL if composited.
- Negative cache: videos that previously produced no useful result (e.g.,
  no transcript) are remembered with a shorter TTL so we don't re-pay.

### Stage 2 — Signal gathering (background, parallel, ≤ 300 ms)
All fetches race concurrently with a hard timeout:

| Signal | Source | Timeout |
|---|---|---|
| Description + chapters | InnerTube `player` / `next` endpoint (already what the page itself fetched) | 250 ms |
| Transcript | InnerTube `get_transcript` / `timedtext` | 300 ms |
| View/like ratio, channel | from page data | free |

Signals that miss their deadline are simply dropped — the AI evaluates with
whatever arrived. **Missing signals never block.**

### Stage 3 — AI inference (background, ≤ 700 ms target)
- **Batching is king**: visible/pending cards are grouped into one structured
  request (up to 20 videos per call) with strict JSON-schema output. One
  round trip evaluates the whole screenful of recommendations.
- **Priority**: viewport-proximate cards first; off-screen cards piggyback on
  the next batch.
- **Streaming**: patch each video's result the moment its chunk parses —
  video 3's new title renders while video 7 is still generating.
- **First-tier model choice** (see §4): Flash-Lite class hosted, Gemini Nano
  on-device, or qwen/LFM sub-1B locally. Titles are short outputs
  (≤ 100 tokens/video) — total generation per batch stays tiny.

### Stage 4 — Fact-check lookup (parallel with Stage 3, opt-in)
- Only when the batch's initial stamp leans `FAKE` or the topic is
  claim-heavy (news, health, finance keywords), fire
  `factchecktools.googleapis.com` `claims.search` (free, ~100–200 ms).
- Races alongside a **400 ms hard timeout**; result upgrades/downgrades the
  stamp with corroborating sources shown in the tooltip.
- This is the only "internet lookup" beyond YouTube's own endpoints, and it
  never sits on the critical path.

### Stage 5 — Patch + animate (content script)
Results are written to the DOM with the animation described in §6.

---

## 4. AI backend selection (speed-ordered)

| Priority | Backend | Expected latency | Notes |
|---|---|---|---|
| 1 | Chrome built-in Prompt API (Gemini Nano) | 100–400 ms | Zero network. Chromium-only bonus. |
| 1 | Local Ollama / llama.cpp (`qwen3:0.6b`-class, Q8) | 100–500 ms | Zero network, Firefox-friendly. Suggested default for power users. |
| 2 | Hosted Flash-Lite class (Gemini free tier) | 500–900 ms p50 | Suggested default for everyone else. Batch requests amortize latency. |
| 3 | Any OpenAI-compatible endpoint | varies | User-configured. |

Design constraints on every provider:

- **Max output ≈ 100 tokens per video** (title + tier + 1-sentence reason).
  We're not asking for essays; models finish in a blink.
- **JSON schema / constrained decoding** wherever supported so parsing is
  deterministic and retry-free.
- **Concurrency pool** (default 4 in-flight batches) with priority queue:
  viewport cards jump the queue.
- **Model-version-tagged cache**: upgrading the model or prompt invalidates
  gracefully (old entries still shown while refreshing in background).

---

## 5. Caching & prefetch strategy

- **IndexedDB stores**: `analyses` (title + stamp + explanation),
  `thumbnails` (composed blobs), `negatives`, `settings`.
- **TTL defaults**: analyses 30 days, thumbnails 90 days (frames don't go
  stale), negatives 7 days.
- **Prefetch triggers**:
  - `IntersectionObserver` with 600 px lookahead (Stage 0).
  - **Hover prefetch**: mousing over a card fires evaluation immediately —
    users hover ~500 ms before clicking; that's free inference time.
  - Watch-page sidebar: batch-evaluate on arrival.
- **Cross-session persistence**: everything above survives browser restarts.
- **Cache warming from DeArrow?** No — different data model, and we want to
  stay fully independent. Our own cache grows as you browse.

---

## 6. The swap animation

Goal: delightful, but **never slower than the data**. The original content is
always fully visible until the replacement arrives — no spinners, no blank
placeholders.

### Title rewrite — "decode" effect
1. When the new title arrives, measure its length difference from the
   original.
2. Characters scramble between random glyphs for ~200 ms (monospace-neutral
   chars: `!<>-_\\/[]{}—=+*^?#`), left-to-right resolving into the final
   title — hacker-terminal aesthetic.
3. **Adaptive duration**: if inference completed in < 150 ms (cache hit or
   Nano-speed backend), the scramble shortens to ~120 ms or is skipped
   entirely for a subtle crossfade. Speed wins; flair fills the remainder.
4. Implemented as one rAF loop per *batch* of elements (not per element) —
   hundreds of simultaneous decodes stay at 60 fps because it's a single
   transform/text pass.

### Thumbnail swap — pixel-grid dissolve
The signature effect: the clickbait thumbnail **pixelates into a coarse,
blurred mosaic that morphs into the real video frame**.

1. New frame (already composited to a blob URL in the background) decodes
   off-screen (`img.decode()`).
2. A lightweight overlay canvas is placed over the thumbnail. The original
   image is first shown as a small grid of large, heavily blurred cells
   (~12×7 blocks, drawn via `ctx.drawImage` downscaled then upscaled with
   `filter: blur()` and `imageSmoothingEnabled: false` — cheap, chunky, and
   unmistakably "pixelated").
3. Over ~450 ms the grid **refines**: cells subdivide in 3 passes (12×7 →
   24×14 → 48×28) with per-cell staggered timing (driven by a seeded noise
   gradient, so the dissolve sweeps across the image like a wave rather than
   a uniform zoom), each pass less blurred than the last.
4. The final pass lands exactly on the full-resolution new frame; overlay is
   removed and the real `<img>` (already swapped underneath) is revealed —
   a perfect, seamless handoff with zero flash.

Performance rules:

- Refinement uses **progressively decimated precomputed bitmaps** (three
  sizes drawn once from the decoded image at swap start), so each rAF frame
  is just `drawImage` of the next handful of cells — no per-frame filtering
  cost. Hundreds of simultaneous dissolves stay at 60 fps.
- **Adaptive duration**: if the frame arrived from cache in < 150 ms, the
  dissolve compresses to a quick two-pass shimmer (~180 ms) — never make a
  fast result look slow.
- Fully off the main thread's critical path: the overlay renders in the
  content script but batches with other running animations in one rAF loop.
- `prefers-reduced-motion`: collapses to a plain crossfade.

### Stamp — pop-in
Badge scales from 0.6 → 1.0 with a slight overshoot (spring curve, ~180 ms)
and a shimmer sweep. Cheap, one-shot `Element.animate()`.

### Accessibility & respect
- Full `prefers-reduced-motion` support: all animations collapse to instant
  swaps.
- Animations never re-trigger for the same video on SPA navigations.

---

## 7. Message protocol (content ⇄ background)

Tiny, versioned, JSON:

```ts
// content → background
{ type: 'evaluate', cards: [{ id: string, title: string, href: string,
  priority: 'viewport' | 'near' | 'idle' }] }

// background → content (per result, streamed per video)
{ type: 'result', id, title?, stamp?, stampExplanation?, thumbUrl?,
  anim: 'full' | 'quick' }
```

- Requests are **coalesced** (two `evaluate` calls within 50 ms merge).
- Duplicate in-flight evaluations for the same `id` are answered by a shared
  promise.

---

## 8. Module map

```text
src/
├── background/
│   ├── index.ts        entry, message router
│   ├── scheduler.ts    priority queue, concurrency pool, coalescing
│   ├── signals.ts      InnerTube description/chapters/transcript fetchers
│   ├── factcheck.ts    ClaimReview lookup (racing, timeout-guarded)
│   └── cache.ts        IndexedDB wrapper (analyses/thumbnails/negatives)
├── content/
│   ├── index.ts        bootstrap, lifecycle
│   ├── observer.ts     MutationObserver + IntersectionObserver, rAF batching
│   ├── dom.ts          SELECTORS + VideoCard extraction
│   ├── ui.ts           animation engine (decode/crossfade/pop-in)
│   └── stamps.ts       badge + tooltip injection
├── ai/
│   ├── types.ts        AIProvider (analyzeBatch)
│   ├── factory.ts      provider selection + fallback chain
│   ├── gemini.ts       Flash-Lite, batch + JSON schema
│   ├── ollama.ts       local, suggested small models
│   ├── nano.ts         Chrome built-in Prompt API
│   └── classify.ts     stamp tier prompt + strict parsing → UNSURE fallback
├── thumbnail/
│   ├── storyboard.ts   spec parsing, level selection
│   ├── frame.ts        deterministic frame math (seeded by videoId)
│   └── render.ts       offscreen canvas crop → blob URL
├── stamps/             tier types, SVG badges, tooltips
├── options/            settings UI
└── utils/              url, idb, hash, dom helpers
```

---

## 9. Testing & performance gates

- **Unit** (Vitest + jsdom): frame math, prompt building, strict response
  parsing (malformed → `UNSURE`), scheduler ordering/coalescing, cache
  invalidation.
- **Perf micro-tests**: synthetic grid of 60 video cards; assert cache-hit
  patch completes in one frame; cold batch of 20 completes with one AI call.
- **E2E** (Playwright, Firefox + Chromium): real YouTube pages, mocked
  backends with configurable latency; assert original content visible at
  all times, swap under animation budget, no duplicate network calls
  (count via request interception).
- **Budget instrumentation**: `performance.mark()` around every stage;
  exposed via `window.dispatchEvent('nobait:debug')` and options page
  diagnostics panel. Fail CI if p95 regressions exceed budget by 20%.

---

## 10. Build phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **P1 — Skeleton** | Manifest (MV3, FF+Chrome), TS + Vite build, empty content/background that logs video IDs | Loads on YouTube, observes SPA nav |
| **P2 — Thumbnails** | Storyboard parse → deterministic frame → swap with crossfade | 60-card grid swaps at 60fps, blob-cached |
| **P3 — Cache + Gemini** | IndexedDB, batch structured prompt, title rewrite + stamp tier via Flash-Lite | One AI call per screenful; parse-strict; negative cache works |
| **P4 — Local & on-device** | Ollama backend, Chrome Prompt API backend, fallback chain | Works fully offline w/ local model |
| **P5 — Delight** | Decode animation (adaptive), stamp pop-in, tooltips w/ explanations | Reduced-motion respected; no jank with 60 simultaneous patches |
| **P6 — Fact-check layer** | ClaimReview racing lookups, tooltip sources | 400ms timeout proven by test |
| **P7 — Options + polish** | Settings UI, channel allowlist, cache controls, perf panel | E2E suite green on FF + Chrome; AMO-ready `.xpi` |

---

## 11. Key decisions & rationale (summary)

1. **Batch-then-stream beats per-video requests.** One structured call for
   ~20 videos divides network overhead by 20; per-chunk parsing restores
   per-video responsiveness.
2. **Lookahead evaluation via IntersectionObserver (600 px)** means
   inference usually finishes before the card is seen — the animation
   becomes the *only* visible delay, and it's beautiful by design.
3. **Small models are sufficient.** Renaming a title and picking one of six
   enums is a toy task for modern sub-1B models and Flash-Lite tiers; we
   lean on strict prompting/schema rather than model scale.
4. **Fact-checking is asynchronous garnish, not gating.** Lookup results
   upgrade a stamp when they arrive in time; they never delay the swap.
5. **Original content is sacred.** No intermediate placeholder states, ever.
