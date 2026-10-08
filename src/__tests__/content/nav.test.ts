import { describe, expect, it } from "vitest";
import { createNavWatcher } from "../../content/nav";

interface FakeWindow {
  location: { href: string };
  setTimeout: (cb: () => void, ms: number) => number;
  setInterval: (cb: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  handlers: Record<string, Array<() => void>>;
}

function makeFakeWindow(initialHref: string): FakeWindow {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    location: { href: initialHref },
    setTimeout: (cb) => {
      cb();
      return 0;
    },
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener(type, cb) {
      (handlers[type] ??= []).push(cb);
    },
    removeEventListener(type, cb) {
      handlers[type] = (handlers[type] ?? []).filter((f) => f !== cb);
    },
    handlers,
  };
}

describe("createNavWatcher", () => {
  it("fires listener on yt-navigate-finish with the new URL", () => {
    const fakeWin = makeFakeWindow("https://www.youtube.com/");
    const watcher = createNavWatcher(fakeWin as unknown as Window);
    const seen: string[] = [];
    watcher.onNavigate((href: string) => seen.push(href));

    fakeWin.location.href = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    fakeWin.handlers["yt-navigate-finish"]?.forEach((cb) => cb());

    expect(seen).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    watcher.dispose();
  });

  it("fires listener on popstate", () => {
    const fakeWin = makeFakeWindow("https://www.youtube.com/");
    const watcher = createNavWatcher(fakeWin as unknown as Window);
    const seen: string[] = [];
    watcher.onNavigate((href: string) => seen.push(href));

    fakeWin.location.href = "https://www.youtube.com/feed/subscriptions";
    fakeWin.handlers["popstate"]?.forEach((cb) => cb());
    expect(seen).toEqual(["https://www.youtube.com/feed/subscriptions"]);
    watcher.dispose();
  });

  it("does not fire when href is unchanged", () => {
    const fakeWin = makeFakeWindow("https://www.youtube.com/");
    const watcher = createNavWatcher(fakeWin as unknown as Window);
    const seen: string[] = [];
    watcher.onNavigate((href: string) => seen.push(href));
    fakeWin.handlers["popstate"]?.forEach((cb) => cb());
    expect(seen).toEqual([]);
    watcher.dispose();
  });

  it("supports dispose without throwing", () => {
    const fakeWin = makeFakeWindow("https://www.youtube.com/");
    const watcher = createNavWatcher(fakeWin as unknown as Window);
    expect(() => watcher.dispose()).not.toThrow();
  });
});
