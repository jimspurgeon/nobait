# nobait Animation System (P5 — Delight)

This document describes the animation engine shipped in P5: the timing
budgets, the three effects, the adaptive-duration policy, reduced-motion
handling, and the performance model that keeps hundreds of simultaneous
patches at 60 fps.

All timings are defined in `src/content/ui.ts` (`TIMING`) and verified by
tests in `src/__tests__/`.

---

## 1. Timing budgets

| Effect                        | Full (cold inference) | Quick (cached / <150 ms) | Instant (reduced motion) |
| ----------------------------- | --------------------- | ------------------------ | ------------------------ |
| Title decode (scramble)       | 200 ms                | 120 ms                   | 0 ms (hard swap)         |
| Thumbnail pixel-grid dissolve | 450 ms                | 180 ms                   | 0 ms (hard swap)         |
| Stamp pop-in (spring)         | 180 ms                | 120 ms                   | 0 ms (appear)            |

The quick-mode threshold is **150 ms measured inference latency**
(`TIMING.fastThresholdMs`): if the background reports the result arrived
from cache or a Nano-speed backend in under 150 ms, the compressed
budgets apply. Speed always wins — never make a fast result look slow.

## 2. Adaptive classification

`classifyTiming({ inferenceMs, cached })` in `src/content/engine.ts`
maps a background-reported latency into a mode:

- `cached: true` or `inferenceMs < 150` → `'quick'`
- otherwise → `'full'`
- `prefers-reduced-motion: reduce` → `'instant'` overrides everything

The classification happens once per result message (cheap), and each
effect queries its own duration via `durationFor(mode, full, quick)`.

## 3. The three effects

### 3.1 Title decode — hacker-terminal scramble

(`animateTitleDecode` in `src/content/ui.ts`)

- New title characters resolve left-to-right over the budget.
- Unresolved characters display random glyphs from a fixed pool
  (`!<>-_\\/[]{}—=+*^?#`), re-rolled each frame.
- Spaces stay spaces (no layout shift during scramble).
- Glyph stream is seeded from `hashSeed(videoId)` for determinism.
- On completion the exact final text is committed.

### 3.2 Pixel-grid thumbnail dissolve — the signature effect

(`animatePixelDissolve` + `src/thumbnail/pixelate.ts`)

Pipeline:

1. The incoming frame is decoded off-screen (`img.decode()`).
2. `buildMosaicPyramid` precomputes three decimated bitmap levels —
   12×7, 24×14, 48×28 — each cell a tiny solid-color canvas whose color
   is the average of its region (achieved via GPU-accelerated
   downscale to `cols×rows` pixels, a box filter, then one readback).
3. A canvas overlay is positioned over the thumbnail; the real
   `<img>` src is swapped beneath it immediately.
4. `buildWaveState` assigns each cell a deterministic arrival
   threshold forming a diagonal sweep with seeded jitter, so
   subdivision cascades like a wave across the image.
5. Each rAF frame paints arrived cells with plain `drawImage` calls
   — no filters, no per-frame computation beyond blitting.
6. At progress 1 the overlay is removed, revealing the already-swapped
   image: zero flash, zero gap.

Failure modes: if the frame fails to decode, the src is hard-swapped
(original content preserved, no blank states — acceptance #7).

### 3.3 Stamp pop-in — spring + shimmer

(`animateStampPop`)

- Scale 0.6 → overshoot ≈1.08 → settle 1.0 via the closed-form
  underdamped spring `springCurve(u) = 1 − 0.4·e^(−6u)·cos(9.5u)`
  (~180 ms).
- Opacity ramps 0.5 → 1 in parallel.
- A diagonal **shimmer sweep** rides alongside: a `::after` overlay
  (translucent 120° light gradient) translates from −100% to +100%
  via a CSS keyframe, injected once per document as
  `#nobait-shimmer-styles`. Its duration is set per-badge via the
  `--nobait-shimmer-ms` custom property so it tracks the adaptive
  pop budget (180 ms full / 120 ms quick), and its color is tunable
  per theme via `--nobait-shimmer-color` (default white @ 55% alpha,
  which reads on both YouTube light and dark themes).
- Both the scale ramp (rAF, transform-only) and the shimmer
  (keyframe, transform-only) are GPU-composited; neither triggers
  layout or paint of the badge itself. The shimmer collapses under
  `prefers-reduced-motion` via both a media-query rule and the
  instant-mode guard, and the class is removed when the pop settles.

## 4. Performance model

- **One shared rAF loop** (`schedule` in `src/content/engine.ts`): every
  decode, dissolve, and pop-in registers into a single loop; per frame
  there is exactly one recalc/style pass for the whole batch.
- **Idle teardown**: when no animations remain, the loop cancels its
  rAF handle; scheduling restarts it lazily.
- **Precomputed bitmaps**: dissolve cost per frame is O(arrived cells)
  drawImage calls; three decimated levels total 84 + 336 + 1344 cells,
  each a solid-color blit — sub-millisecond even for dozens of
  concurrent dissolves.
- **Overlay cap**: overlay resolution is clamped to 640×360 so huge
  thumbnails can't blow the paint budget.
- **Jank instrumentation**: each frame is wrapped with
  `performance.mark('nobait:loop:frame')`; per-anim cost > 4 ms is
  flagged via `nobait:loop:jank-risk` marks.
- Animations whose element leaves the DOM self-cancel (cards removed
  by YouTube during scroll).

## 5. Instrumentation marks

Every stage emits `performance.mark()` (prefixed `nobait:`):

| Mark                              | Meaning                                          |
| --------------------------------- | ------------------------------------------------ |
| `decode:start` / `decode:end`     | scramble begin / settle (detail: mode, dur)      |
| `dissolve:start` / `dissolve:end` | dissolve lifecycle                               |
| `pop:start` / `pop:end`           | stamp pop lifecycle                              |
| `loop:frame`                      | one shared-loop tick (detail: active anim count) |
| `loop:jank-risk`                  | an anim callback exceeded 4 ms                   |
| `pixelate:pyramid-built`          | pyramid construction cost                        |

`performance.measure` pairs (`decode:duration`, `dissolve:duration`,
`pop:duration`) are emitted on completion for budget verification
against §1.

## 6. Reduced motion

`reduceMotion()` caches a `(prefers-reduced-motion: reduce)`
MediaQueryList with a live change listener, so an OS toggle mid-session
takes effect on the next classified result. In instant mode every effect
performs a hard swap/settle with no scheduling, no overlay, no transforms.
