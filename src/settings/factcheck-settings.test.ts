import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readSettings,
  writeSettings,
  getApiKey,
  isLayerAvailable,
  DEFAULT_SETTINGS,
} from "./factcheck-settings.js";

const SETTINGS_KEY = "nobait:factcheck-settings";

function makeStorageArea(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: async (key: string) => {
      const out: Record<string, unknown> = {};
      if (key in store || store.has(key)) out[key] = store.get(key);
      return out;
    },
    set: async (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
    },
    _store: store,
  };
}

describe("factcheck-settings", () => {
  let savedBrowser: unknown;

  beforeEach(() => {
    savedBrowser = (globalThis as Record<string, unknown>)["browser"];
  });

  afterEach(() => {
    if (savedBrowser === undefined) {
      delete (globalThis as Record<string, unknown>)["browser"];
    } else {
      (globalThis as Record<string, unknown>)["browser"] = savedBrowser;
    }
  });

  it("returns defaults when no browser API exists", async () => {
    delete (globalThis as Record<string, unknown>)["browser"];
    const s = await readSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults when storage area is empty", async () => {
    const area = makeStorageArea({});
    (globalThis as Record<string, unknown>)["browser"] = {
      storage: { local: area },
    };
    const s = await readSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it("reads settings from browser.storage.local", async () => {
    const area = makeStorageArea({
      [SETTINGS_KEY]: { apiKey: "test-key-123", enabled: true, timeoutMs: 250 },
    });
    (globalThis as Record<string, unknown>)["browser"] = {
      storage: { local: area },
    };
    const s = await readSettings();
    expect(s.apiKey).toBe("test-key-123");
    expect(s.enabled).toBe(true);
    expect(s.timeoutMs).toBe(250);
  });

  it("falls back to defaults on malformed stored values", async () => {
    const area = makeStorageArea({
      [SETTINGS_KEY]: { apiKey: 42, enabled: "yes", timeoutMs: "fast" },
    });
    (globalThis as Record<string, unknown>)["browser"] = {
      storage: { local: area },
    };
    const s = await readSettings();
    expect(s.apiKey).toBeNull(); // non-string apiKey → default null
    expect(s.enabled).toBe(true); // non-boolean enabled → default true
    expect(s.timeoutMs).toBe(400); // non-number timeout → default 400
  });

  it("rejects non-positive timeout values", async () => {
    const area = makeStorageArea({
      [SETTINGS_KEY]: { apiKey: "k", enabled: true, timeoutMs: -5 },
    });
    (globalThis as Record<string, unknown>)["browser"] = {
      storage: { local: area },
    };
    const s = await readSettings();
    expect(s.timeoutMs).toBe(400);
  });

  it("writeSettings merges with current state", async () => {
    const area = makeStorageArea({
      [SETTINGS_KEY]: { apiKey: "old", enabled: true, timeoutMs: 400 },
    });
    (globalThis as Record<string, unknown>)["browser"] = {
      storage: { local: area },
    };
    await writeSettings({ apiKey: "new-key" });
    const stored = area._store.get(SETTINGS_KEY) as Record<string, unknown>;
    expect(stored["apiKey"]).toBe("new-key");
    expect(stored["enabled"]).toBe(true); // preserved
  });

  it("getApiKey returns trimmed key", async () => {
    const area = makeStorageArea({
      [SETTINGS_KEY]: { apiKey: "  padded-key  ", enabled: true },
    });
    (globalThis as Record<string, unknown>)["browser"] = {
      storage: { local: area },
    };
    expect(await getApiKey()).toBe("padded-key");
  });

  it("getApiKey returns null for blank key", async () => {
    const area = makeStorageArea({
      [SETTINGS_KEY]: { apiKey: "   ", enabled: true },
    });
    (globalThis as Record<string, unknown>)["browser"] = {
      storage: { local: area },
    };
    expect(await getApiKey()).toBeNull();
  });

  it("isLayerAvailable false when disabled", async () => {
    const area = makeStorageArea({
      [SETTINGS_KEY]: { apiKey: "key", enabled: false },
    });
    (globalThis as Record<string, unknown>)["browser"] = {
      storage: { local: area },
    };
    expect(await isLayerAvailable()).toBe(false);
  });

  it("isLayerAvailable false when no key", async () => {
    const area = makeStorageArea({});
    (globalThis as Record<string, unknown>)["browser"] = {
      storage: { local: area },
    };
    expect(await isLayerAvailable()).toBe(false);
  });

  it("isLayerAvailable true with key and enabled", async () => {
    const area = makeStorageArea({
      [SETTINGS_KEY]: { apiKey: "key", enabled: true },
    });
    (globalThis as Record<string, unknown>)["browser"] = {
      storage: { local: area },
    };
    expect(await isLayerAvailable()).toBe(true);
  });
});
