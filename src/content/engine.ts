/**
 * Shared types for the content-script animation engine.
 *
 * The engine implements the PLAN.md §6 swap choreography:
 * decode (title scramble), pixel-grid dissolve (thumbnail), and
 * stamp pop-in — all adaptive to measured inference latency, all
 * collapsible under `prefers-reduced-motion`, and all driven by a
 * single shared rAF loop so hundreds of simultaneous patches stay
 * at 60 fps.
 */

/** How the background signals the animation budget for a result. */
export type AnimMode = "full" | "quick" | "instant";

/**
 * Latency classification driving adaptive timing (PLAN.md §6.3).
 * The background reports wall-clock inference latency per result;
 * we compress animations so fast data never looks slow.
 */
export interface TimingContext {
  /**
   * Wall-clock ms from evaluate-request to result arrival
   * (cache hits arrive in < 150 ms).
   */
  inferenceMs: number;
  /** True when the result was served from cache. */
  cached?: boolean;
}

/** Classify latency into an animation budget. */
export function classifyTiming(ctx: TimingContext): AnimMode {
  if (reduceMotion()) return "instant";
  if (ctx.cached || ctx.inferenceMs < 150) return "quick";
  return "full";
}

let reducedMotionCache: boolean | null = null;
let motionQuery: MediaQueryList | null = null;

/**
 * Detect `prefers-reduced-motion: reduce` (acceptance #5).
 * Cached, with a live listener so a mid-session OS toggle is
 * respected on the next classification. Falls back conservatively
 * in environments without matchMedia (SSR/tests).
 */
export function reduceMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  if (motionQuery === null) {
    motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    motionQuery.addEventListener?.("change", () => {
      reducedMotionCache = motionQuery!.matches;
    });
  }
  if (reducedMotionCache === null) reducedMotionCache = motionQuery.matches;
  return reducedMotionCache;
}

/** Test hook: reset the cached media-query state. */
export function _resetMotionCacheForTests(): void {
  reducedMotionCache = null;
  motionQuery = null;
}

/** A single scheduled animation step in the shared rAF loop. */
export interface Tick {
  /** rAF timestamp (ms). */
  t: number;
}

type FrameFn = (tick: Tick) => boolean; // return false → done

interface ActiveAnim {
  fn: FrameFn;
  id: string;
  name: string;
}

const activeAnims = new Map<string, ActiveAnim>();
let rafHandle: number | null = null;
let frameCount = 0;

/**
 * The one shared rAF loop (PLAN.md §6 rule 4, acceptance #6).
 * Every animation — scramble passes, dissolve passes, spring
 * pop-ins — registers here; one rAF callback drives all of them,
 * so there is exactly one style-recalc/layout pass per frame no
 * matter how many cards are animating.
 */
export function schedule(id: string, name: string, fn: FrameFn): void {
  const already = activeAnims.has(id);
  activeAnims.set(id, { fn, id, name });
  if (!already && rafHandle === null) {
    rafHandle = requestAnimationFrame(loop);
  }
}

/** Remove an animation from the loop (cancellation / cleanup). */
export function unschedule(id: string): void {
  activeAnims.delete(id);
}

function loop(t: number): void {
  frameCount++;
  perfMark("loop:frame", { detail: { anims: activeAnims.size } });
  // Copy to survive mutation during iteration (finishers unschedule).
  const snapshot = [...activeAnims.values()];
  let longFrames = 0;
  for (const anim of snapshot) {
    const started = performance.now();
    try {
      const alive = anim.fn({ t });
      if (!alive) activeAnims.delete(anim.id);
    } catch {
      // A broken animation must never take down the shared loop.
      activeAnims.delete(anim.id);
    }
    const cost = performance.now() - started;
    if (cost > 4) longFrames++;
  }
  if (longFrames > 0) {
    perfMark("loop:jank-risk", { detail: { count: longFrames } });
  }
  if (activeAnims.size > 0) {
    rafHandle = requestAnimationFrame(loop);
  } else {
    // Idle: stop the loop entirely; `schedule` restarts lazily.
    rafHandle = null;
  }
}

/** performance.mark wrapper guarded for odd embedding contexts. */
export function perfMark(name: string, opts?: PerformanceMarkOptions): void {
  try {
    performance.mark(`nobait:${name}`, opts);
  } catch {
    /* instrumentation must never throw */
  }
}

export function perfMeasure(name: string, from: string, to: string): void {
  try {
    performance.measure(`nobait:${name}`, `nobait:${from}`, `nobait:${to}`);
  } catch {
    /* missing marks are fine (e.g. cleared buffer) */
  }
}

/** Expose diagnostics for the debug event (AGENTS.md). */
export function loopStats(): { activeAnims: number; frames: number } {
  return { activeAnims: activeAnims.size, frames: frameCount };
}
