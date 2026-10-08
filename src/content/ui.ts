/**
 * Animation engine for DOM patches — batched single-rAF design per PLAN §6.
 *
 * ALL running crossfades advance inside ONE shared requestAnimationFrame
 * loop, so 60 simultaneous swaps cost a handful of callbacks per frame
 * rather than 60 separate animation chains. `prefers-reduced-motion`
 * collapses the 250ms crossfade to an instant swap (no rAF traffic).
 */

const prefersReducedMotion = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------ img fades ----

interface FadeJob {
  /** Snapshot overlay covering the img while the new src fades in. */
  canvas: HTMLCanvasElement;
  start: number;
  duration: number;
}

const fadeJobs = new Set<FadeJob>();
let fadeRaf: number | null = null;

function fadeTick(now: number): void {
  const done: FadeJob[] = [];
  for (const job of fadeJobs) {
    const t = Math.min(1, (now - job.start) / job.duration);
    job.canvas.style.opacity = String(1 - t);
    if (t >= 1) {
      job.canvas.remove();
      done.push(job);
    }
  }
  for (const j of done) fadeJobs.delete(j);
  if (fadeJobs.size > 0) fadeRaf = requestAnimationFrame(fadeTick);
  else fadeRaf = null;
}

function ensureFadeLoop(): void {
  if (fadeRaf === null) fadeRaf = requestAnimationFrame(fadeTick);
}

/**
 * Fades the current pixels of `img` into `newSrc` (same-element swap).
 * The old image is snapshotted onto an overlay canvas so decoding the new
 * src can't flash the old image away mid-fade. Reduces to a plain src
 * replacement under reduced motion.
 */
export function crossfadeImageSrc(img: HTMLImageElement, newSrc: string, durationMs = 250): void {
  if (prefersReducedMotion() || !img.complete || img.getAttribute('src') === '' || img.naturalWidth === 0) {
    img.src = newSrc;
    return;
  }

  const w = img.clientWidth || img.naturalWidth;
  const h = img.clientHeight || img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  try {
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
  } catch {
    // CORS-tainted canvas — degrade to simple swap, never blank.
    img.src = newSrc;
    return;
  }

  const parent = img.parentElement;
  if (!parent) {
    img.src = newSrc;
    return;
  }
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
  const anchor = (img.closest('ytd-thumbnail, .ytd-thumbnail') as HTMLElement | null) ?? parent;
  if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
  anchor.appendChild(canvas);

  img.src = newSrc;
  fadeJobs.add({ canvas, start: performance.now(), duration: durationMs });
  ensureFadeLoop();
}

/**
 * Process many images in the same frame: force layout once, then start
 * all swaps. They share the single rAF loop above, keeping a 60-card grid
 * inside one frame budget.
 */
export function batchCrossfade(
  swaps: Array<{ img: HTMLImageElement; src: string }>,
  durationMs = 250
): void {
  // Force a single synchronous layout read before mutating styles.
  for (const s of swaps) void s.img.naturalWidth;
  if (prefersReducedMotion()) {
    for (const s of swaps) s.img.src = s.src;
    return;
  }
  for (const s of swaps) crossfadeImageSrc(s.img, s.src, durationMs);
}

// ----------------------------------------------------- element utilities ----

export interface SwapOptions {
  /** Crossfade duration (ms). Reduced-motion overrides to 0. */
  durationMs?: number;
}

interface SwapJob {
  from: HTMLElement;
  to: HTMLElement;
  start: number;
  duration: number;
}

const swapJobs = new Set<SwapJob>();
let swapRaf: number | null = null;

function swapTick(now: number): void {
  const finished: SwapJob[] = [];
  for (const job of swapJobs) {
    const t = Math.min(1, (now - job.start) / job.duration);
    job.to.style.opacity = String(t);
    job.from.style.opacity = String(1 - t);
    if (t >= 1) {
      job.from.style.opacity = '0';
      job.from.style.pointerEvents = 'none';
      job.to.style.opacity = '1';
      job.from.remove();
      finished.push(job);
    }
  }
  for (const f of finished) swapJobs.delete(f);
  if (swapJobs.size > 0) swapRaf = requestAnimationFrame(swapTick);
  else swapRaf = null;
}

/**
 * Replace element `from` with `to` using a crossfade (caller positions
 * `to` over `from`). Shares the swap ticker with every other live swap.
 */
export function crossfadeSwap(from: HTMLElement, to: HTMLElement, opts: SwapOptions = {}): void {
  const duration = prefersReducedMotion() ? 0 : (opts.durationMs ?? 250);
  if (duration === 0) {
    to.style.opacity = '1';
    from.remove();
    return;
  }
  swapJobs.add({ from, to, start: performance.now(), duration });
  if (swapRaf === null) swapRaf = requestAnimationFrame(swapTick);
}

/**
 * Fade a newly-inserted element in. Still reduced-motion aware.
 */
export function fadeIn(el: HTMLElement, durationMs = 200): void {
  if (prefersReducedMotion()) {
    el.style.opacity = '1';
    return;
  }
  el.style.opacity = '0';
  el.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: durationMs,
    easing: 'ease-out',
    fill: 'forwards',
  });
}
