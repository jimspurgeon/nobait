/**
 * Typed WebExtension API shim — the ONE place where `browser` vs `chrome`
 * feature detection happens.
 *
 * Firefox-first: when the promise-based `browser` global exists we use it
 * directly (both runtime and storage). The Chrome-callback global is only
 * used as a fallback; consumers see one promise-based surface.
 *
 * The public surface carries no `any`. Types are structural so unit tests
 * can stub `globalThis.browser` (even after module load — accessors are
 * lazy) without the full polyfill surface; members mirror
 * `@types/webextension-polyfill` (the `Browser` namespace). If neither
 * global exists (unit tests, plain pages), members are `undefined` and
 * callers degrade gracefully.
 */

/** Listener usable with `webext.runtime.onMessage.addListener`. */
export type WebExtMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse?: (response: unknown) => void,
) => unknown;

export interface WebExtRuntime {
  sendMessage(message: unknown): PromiseLike<unknown>;
  onMessage: {
    addListener(cb: WebExtMessageListener): void;
  };
}

export interface WebExtStorage {
  local: {
    get(
      keys?: string | string[] | Record<string, unknown> | null,
    ): PromiseLike<Record<string, unknown>>;
    set(items: Record<string, unknown>): PromiseLike<void>;
  };
}

export interface WebExtTabs {
  query(q: unknown): PromiseLike<Array<{ id?: number }>>;
  sendMessage(tabId: number, message: unknown): PromiseLike<unknown>;
}

interface BrowserGlobal {
  runtime?: WebExtRuntime;
  storage?: WebExtStorage;
  tabs?: WebExtTabs;
}

/** Raw globals — kept local; nothing outside this module reads them. */
const g = globalThis as Record<string, unknown>;

function browserGlobal(): BrowserGlobal | undefined {
  return g["browser"] as BrowserGlobal | undefined;
}

function chromeGlobal(): BrowserGlobal | undefined {
  return g["chrome"] as BrowserGlobal | undefined;
}

function pickRuntime(): WebExtRuntime | undefined {
  const b = browserGlobal();
  if (b?.runtime?.onMessage) return b.runtime;
  const c = chromeGlobal();
  if (c?.runtime?.onMessage) return c.runtime;
  return undefined;
}

function pickStorage(): WebExtStorage | undefined {
  const b = browserGlobal();
  if (b?.storage?.local) return b.storage;
  const c = chromeGlobal();
  if (c?.storage?.local) return c.storage;
  return undefined;
}

function pickTabs(): WebExtTabs | undefined {
  const b = browserGlobal();
  if (b?.tabs) return b.tabs;
  const c = chromeGlobal();
  if (c?.tabs) return c.tabs;
  return undefined;
}

/**
 * The standardized extension API surface. Members are lazy getters that
 * re-resolve `browser`/`chrome` on each access, so late-installed test
 * stubs are honored. Each member is `undefined` outside an extension
 * context (unit tests, plain web pages).
 */
export const webext = {
  get runtime(): WebExtRuntime | undefined {
    return pickRuntime();
  },
  get storage(): WebExtStorage | undefined {
    return pickStorage();
  },
  get tabs(): WebExtTabs | undefined {
    return pickTabs();
  },
};

export type WebExt = typeof webext;

/** True when running in an extension context with a message API. */
export function hasRuntimeApi(): boolean {
  return pickRuntime() !== undefined;
}
