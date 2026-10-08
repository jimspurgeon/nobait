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

/** Debounce helper used to coalesce rapid DOM-change callbacks. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (t !== undefined) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
