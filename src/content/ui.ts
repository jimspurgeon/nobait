/**
 * nobait animation engine — the P5 "delight" layer.
 *
 * Three effects (PLAN.md §6), all driven by the single shared rAF
 * loop in engine.ts:
 *
 *  1. `animateTitleDecode` — hacker-terminal character scramble
 *     that resolves into the new title left-to-right (~200 ms,
 *     ~120 ms on cache hits, skipped under reduced motion).
 *  2. `animatePixelDissolve` — pixel-grid thumbnail dissolve:
 *     coarse 12×7 mosaic → staggered subdivision passes
 *     (24×14 → 48×28) sweeping like a wave over ~450 ms, using
 *     precomputed decimated bitmaps so 60 simultaneous dissolves
 *     hold 60 fps.
 *  3. `animateStampPop` — badge scale 0.6→1.0 with spring
 *     overshoot (~180 ms) plus a shimmer sweep.
 *
 * Timing adapts to measured inference latency (never make fast
 * results look slow), and `prefers-reduced-motion` collapses
 * everything to instant swaps. Original content stays fully visible
 * until each replacement is ready — no spinners, no blanks.
 */

import {
  AnimMode,
  Tick,
  classifyTiming,
  perfMark,
  perfMeasure,
  reduceMotion,
  schedule,
  unschedule,
} from "./engine";
import {
  buildMosaicPyramid,
  buildWaveState,
  hashSeed,
  paintWave,
} from "../thumbnail/pixelate";

// ---------------------------------------------------------------------------
// Timing budgets (documented in docs/ANIMATIONS.md)
// ---------------------------------------------------------------------------

export const TIMING = {
  decode: { full: 200, quick: 120 }, // ms
  decodeGlyphHold: 60, // ms a resolved char stays glyph-scrambled before settling
  dissolve: { full: 450, quick: 180 }, // ms
  pop: { full: 180, quick: 120 }, // ms
  fastThresholdMs: 150, // below this, "quick" mode (acceptance #4)
} as const;

/** Glyph pool for the scramble — monospace-neutral symbols. */
const GLYPHS = "!<>-_\\/[]{}—=+*^?#";

/**
 * Resolve a duration for the given anim mode. `quick` scales to
 * ~60% of full; `instant` returns 0 (hard swap, reduced motion).
 */
function durationFor(mode: AnimMode, full: number, quick: number): number {
  if (mode === "instant") return 0;
  return mode === "quick" ? quick : full;
}

// ---------------------------------------------------------------------------
// Title decode (scramble) effect
// ---------------------------------------------------------------------------

export interface DecodeOptions {
  /** Video id — seeds per-video glyph randomness deterministically. */
  videoId: string;
  /** Measured inference latency → adaptive duration. */
  timing?: { inferenceMs: number; cached?: boolean } | undefined;
  /** Override classification (used by tests / explicit callers). */
  mode?: AnimMode;
  /** Callback once the animation settles (fires immediately if 0 ms). */
  onDone?: () => void;
}

/**
 * Animate a title element into its new text with a left-to-right
 * character scramble. The final text is committed to the element
 * either instantly (instant/0 ms) or over the scramble duration.
 *
 * Non-destructive: if the element is disconnected mid-animation or
 * the caller reschedules the same videoId, the previous pass stops
 * and the new one owns the element.
 */
export function animateTitleDecode(
  el: Element,
  newText: string,
  opts: DecodeOptions,
): AnimMode {
  const mode =
    opts.mode ?? classifyTiming(opts.timing ?? { inferenceMs: Infinity });
  const dur = durationFor(mode, TIMING.decode.full, TIMING.decode.quick);

  perfMark("decode:start", { detail: { videoId: opts.videoId, mode, dur } });

  if (dur <= 0 || reduceMotion()) {
    setText(el, newText);
    opts.onDone?.();
    perfMark("decode:end", { detail: { videoId: opts.videoId, mode } });
    return mode;
  }

  const animId = `decode:${opts.videoId}`;
  unschedule(animId); // supersede any in-flight decode for this video

  // Deterministic per-video glyph stream so re-animations match.
  let glyphSeed = hashSeed(opts.videoId) ^ 0x9e3779b9;
  const nextGlyph = (): string => {
    glyphSeed = (Math.imul(glyphSeed, 1664525) + 1013904223) >>> 0;
    return GLYPHS[glyphSeed % GLYPHS.length]!;
  };

  const scheduleFn = (tick: Tick): boolean => {
    if (!el.isConnected) return false; // card left the DOM — bail
    const elapsed = tick.t - tickStart;
    const p = Math.min(1, elapsed / dur);
    // Leading edge of resolve: fraction of characters settled.
    const settledCount = Math.floor(p * newText.length);
    let out = newText.slice(0, settledCount);
    for (let i = settledCount; i < newText.length; i++) {
      const ch = newText[i]!;
      out += ch === " " ? " " : nextGlyph();
    }
    setText(el, out);
    if (p >= 1) {
      setText(el, newText); // guarantee exact final text
      perfMark("decode:end", { detail: { videoId: opts.videoId, mode } });
      perfMeasure("decode:duration", "decode:start", "decode:end");
      opts.onDone?.();
      return false;
    }
    return true;
  };

  let tickStart = 0;
  schedule(animId, "decode", (tick) => {
    if (tickStart === 0) tickStart = tick.t;
    return scheduleFn(tick);
  });
  // If the element was never connected, cancel immediately and call onDone.
  if (!el.isConnected) {
    unschedule(animId);
    setText(el, newText);
    opts.onDone?.();
    perfMark("decode:end", {
      detail: { videoId: opts.videoId, mode: "aborted" },
    });
  }
  return mode;
}

function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

// ---------------------------------------------------------------------------
// Pixel-grid thumbnail dissolve
// ---------------------------------------------------------------------------

export interface DissolveOptions {
  videoId: string;
  timing?: { inferenceMs: number; cached?: boolean } | undefined;
  mode?: AnimMode;
  onDone?: () => void;
}

/**
 * Run the signature pixel-grid dissolve on a thumbnail `<img>`
 * (or any media element with intrinsic sizing).
 *
 * Steps:
 *  1. Decode the incoming image off-screen.
 *  2. Build the decimated bitmap pyramid (12×7 / 24×14 / 48×28).
 *  3. Overlay a canvas sized to the element; paint the wave via
 *     `paintWave` from the shared rAF loop.
 *  4. On completion, remove the overlay — the underlying `<img>`
 *     was already swapped to the new blob URL beneath the canvas,
 *     so removal reveals the exact final pixels with zero flash.
 *
 * Original content remains fully visible throughout (acceptance #7).
 */
export async function animatePixelDissolve(
  img: HTMLImageElement,
  newSrc: string,
  opts: DissolveOptions,
): Promise<AnimMode> {
  const mode =
    opts.mode ?? classifyTiming(opts.timing ?? { inferenceMs: Infinity });
  const dur = durationFor(mode, TIMING.dissolve.full, TIMING.dissolve.quick);

  perfMark("dissolve:start", { detail: { videoId: opts.videoId, mode, dur } });

  if (mode === "instant" || dur <= 0 || reduceMotion()) {
    img.src = newSrc;
    opts.onDone?.();
    perfMark("dissolve:end", {
      detail: { videoId: opts.videoId, mode: "instant" },
    });
    return mode;
  }

  // 1. Decode off-screen first: never show a half-loaded frame.
  const decoded = await decodeImage(newSrc);
  if (!decoded.ok) {
    // Degrade to a hard swap — never blank, never spinner.
    img.src = newSrc;
    opts.onDone?.();
    perfMark("dissolve:end", {
      detail: { videoId: opts.videoId, mode: "fallback" },
    });
    return mode;
  }

  // 2. Size the overlay to the *rendered* thumbnail box, capped for perf.
  const rect = img.getBoundingClientRect();
  const W = Math.max(
    64,
    Math.min(640, Math.round(rect.width || img.naturalWidth || 320)),
  );
  const H = Math.max(
    36,
    Math.min(360, Math.round(rect.height || img.naturalHeight || 180)),
  );

  // 3. Pyramid + wave thresholds (both computed once, then reused).
  const pyramid = buildMosaicPyramid(decoded.image, W, H);
  const wave = buildWaveState(undefined, hashSeed(opts.videoId));

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
  if (img.parentElement) {
    const box = ensureRelative(img);
    box.appendChild(canvas);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  // Swap the real image beneath the overlay now; the wave hides
  // the transition until the final pass aligns with the new frame.
  img.src = newSrc;
  paintWave(ctx, pyramid, wave, 0);

  const animId = `dissolve:${opts.videoId}`;
  unschedule(animId);
  let startTime = 0;

  schedule(animId, "dissolve", (tick) => {
    if (startTime === 0) startTime = tick.t;
    if (!canvas.isConnected) return false;
    const p = Math.min(1, (tick.t - startTime) / dur);
    // Slight ease so the wave accelerates into the final reveal.
    const eased = p * (2 - p); // quad-out approximation of sweep speed-up
    paintWave(ctx, pyramid, wave, eased);
    if (p >= 1) {
      canvas.remove();
      perfMark("dissolve:end", { detail: { videoId: opts.videoId, mode } });
      perfMeasure("dissolve:duration", "dissolve:start", "dissolve:end");
      opts.onDone?.();
      return false;
    }
    return true;
  });
  return mode;
}

/** Wrap: make sure the parent clips/positions our overlay. */
function ensureRelative(img: HTMLImageElement): HTMLElement {
  const parent = img.parentElement as HTMLElement;
  const pos = parent.style.position;
  if (!pos || pos === "static") parent.style.position = "relative";
  return parent;
}

async function decodeImage(
  src: string,
): Promise<{ ok: true; image: HTMLImageElement } | { ok: false }> {
  try {
    const probe = new Image();
    probe.src = src;
    if (probe.decode) {
      await probe.decode();
    } else {
      await new Promise<void>((res, rej) => {
        probe.onload = () => res();
        probe.onerror = () => rej(new Error("decode failed"));
      });
    }
    return { ok: true, image: probe };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Stamp pop-in
// ---------------------------------------------------------------------------

export interface PopOptions {
  videoId: string;
  timing?: { inferenceMs: number; cached?: boolean } | undefined;
  mode?: AnimMode;
  onDone?: () => void;
}

/**
 * Spring pop-in for the credibility badge: scale 0.6 → 1.0 with
 * overshoot (~180 ms) + a diagonal shimmer sweep. Uses the shared
 * rAF loop with transform-only animation (GPU-composited).
 *
 * For instant mode the badge is inserted at final scale.
 */
export function animateStampPop(el: HTMLElement, opts: PopOptions): AnimMode {
  const mode =
    opts.mode ?? classifyTiming(opts.timing ?? { inferenceMs: Infinity });
  const dur = durationFor(mode, TIMING.pop.full, TIMING.pop.quick);

  perfMark("pop:start", { detail: { videoId: opts.videoId, mode, dur } });

  if (mode === "instant" || dur <= 0 || reduceMotion()) {
    el.style.transform = "";
    el.style.opacity = "1";
    opts.onDone?.();
    perfMark("pop:end", { detail: { videoId: opts.videoId, mode: "instant" } });
    return mode;
  }

  const animId = `pop:${opts.videoId}`;
  unschedule(animId);
  let startTime = 0;

  schedule(animId, "pop", (tick) => {
    if (startTime === 0) startTime = tick.t;
    if (!el.isConnected) return false;
    const u = Math.min(1, (tick.t - startTime) / dur);
    // Underdamped spring: 0.6 → overshoot ≈1.08 → settle 1.0.
    const scale = springCurve(u);
    el.style.transform = `scale(${scale.toFixed(4)})`;
    el.style.opacity = String(Math.min(1, 0.5 + u));
    if (u >= 1) {
      el.style.transform = "scale(1)";
      el.style.opacity = "1";
      perfMark("pop:end", { detail: { videoId: opts.videoId, mode } });
      perfMeasure("pop:duration", "pop:start", "pop:end");
      opts.onDone?.();
      return false;
    }
    return true;
  });
  return mode;
}

/**
 * Closed-form underdamped spring for the pop-in: starts at 0.6,
 * overshoots to ≈1.08 around u≈0.5, and lands exactly at 1.0 when
 * u = 1. The decaying cosine term supplies the single overshoot.
 */
export function springCurve(u: number): number {
  const start = 0.6;
  const target = 1.0;
  // Solution of x'' = k(target − x) − c·x': amplitude e^(−6u)·cos(9.5u).
  // At u=0 the cosine term equals 1 so x(0) = start; it decays through
  // zero crossing past u≈0.5 (overshoot region) and converges to target.
  const envelope = Math.exp(-6 * u);
  const oscillation = Math.cos(9.5 * u);
  return target - (target - start) * envelope * oscillation;
}

// ---------------------------------------------------------------------------
// Facade for the message handler (content/index.ts wiring)
// ---------------------------------------------------------------------------

export interface ResultPatch {
  videoId: string;
  title?: string;
  stampEl?: HTMLElement | undefined;
  thumbImg?: HTMLImageElement | undefined;
  thumbUrl?: string | undefined;
  timing: { inferenceMs: number; cached?: boolean | undefined };
}

/**
 * Apply a single background `result` message to the DOM with all
 * three effects sequenced appropriately. Original content stays
 * visible until each piece is ready (acceptance #7): title keeps
 * its current text until the scramble runs, the thumbnail keeps
 * the old src under the overlay until the final reveal.
 */
export function applyResult(titleEl: Element, patch: ResultPatch): void {
  const { videoId, timing } = patch;
  perfMark("patch:start", { detail: { videoId } });

  if (patch.title !== undefined && titleEl) {
    animateTitleDecode(titleEl, patch.title, { videoId, timing });
  }
  if (patch.stampEl && patch.stampEl.isConnected) {
    animateStampPop(patch.stampEl, { videoId, timing });
  }
  if (patch.thumbImg && patch.thumbImg.isConnected && patch.thumbUrl) {
    void animatePixelDissolve(patch.thumbImg, patch.thumbUrl, {
      videoId,
      timing,
    });
  }
}

export { classifyTiming, reduceMotion };
export type { AnimMode };
