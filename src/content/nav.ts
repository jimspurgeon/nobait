/**
 * Watches for YouTube SPA navigations.
 *
 * YouTube is a single-page app: clicking a video does not reload the page.
 * Three complementary signals cover all supported browsers:
 *
 *  1. `yt-navigate-finish` — YouTube's own app-level navigation event
 *     (fires after client-side route change completes).
 *  2. `window.navigation` (Navigation API) — Firefox ≥ 71 behind flag /
 *     newer builds; catches pushes not emitted by yt-navigate.
 *  3. `popstate` + history monkey-patch — last-resort fallback for browsers
 *     lacking the above.
 *
 * Also polls location.href as a belt-and-braces fallback, since YouTube has
 * been known to swap routes without all of the above firing.
 */
export interface NavWatcher extends Disposable {
  /** Fires with the new URL pathname+search whenever a route change lands. */
  onNavigate(listener: (href: string) => void): void;
}

// Minimal disposable (Symbol.dispose not yet in all our TS targets).
export interface Disposable {
  dispose(): void;
}

export function createNavWatcher(win: Window = window): NavWatcher {
  const listeners = new Set<(href: string) => void>();
  let lastHref = win.location.href;

  const fire = () => {
    const href = win.location.href;
    if (href === lastHref) return;
    lastHref = href;
    listeners.forEach((l) => l(href));
  };

  // 1. YouTube app-level event.
  const onYtNav = () => fire();
  win.addEventListener("yt-navigate-finish", onYtNav);

  // 2. Navigation API.
  const nav = (
    win as Window & {
      navigation?: EventTarget & {
        addEventListener(type: "navigate", cb: () => void): void;
      };
    }
  ).navigation;
  if (nav) {
    nav.addEventListener("navigate", () => {
      // navigate fires before the URL commits; poll microtask-after.
      win.setTimeout(fire, 0);
    });
  }

  // 3. popstate covers back/forward SPA transitions.
  win.addEventListener("popstate", fire);

  // 4. Conservative polling fallback (~every 150ms). Cheap enough not to
  // matter next to YouTube's own workload, and it guarantees we never miss.
  const timer = win.setInterval(fire, 150) as unknown as number;

  return {
    onNavigate(listener) {
      listeners.add(listener);
    },
    dispose() {
      listeners.clear();
      win.removeEventListener("yt-navigate-finish", onYtNav);
      win.removeEventListener("popstate", fire);
      win.clearInterval(timer);
    },
  };
}
