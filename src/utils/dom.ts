/**
 * Thin debounce utility for batching DOM observations
 */
export function debounce<F extends (...args: any[]) => void>(fn: F, waitMs: number): (...args: Parameters<F>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<F>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
}
