/**
 * Generic DOM helpers shared across modules.
 */

/** Runs `fn` once the element exists in the document; retries with backoff. */
export function waitFor(
  selector: string,
  fn: (el: Element) => void,
  opts: { retries?: number; baseDelayMs?: number } = {},
): void {
  const { retries = 10, baseDelayMs = 50 } = opts;
  let attempt = 0;
  const tick = () => {
    const el = document.querySelector(selector);
    if (el) {
      fn(el);
      return;
    }
    if (attempt++ < retries) {
      setTimeout(tick, baseDelayMs * Math.pow(1.5, attempt));
    }
  };
  tick();
}

/**
 * Debounce utility for batching DOM observations.
 */
export function debounce<F extends (...args: never[]) => void>(
  fn: F,
  waitMs: number,
): (...args: Parameters<F>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<F>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
}
