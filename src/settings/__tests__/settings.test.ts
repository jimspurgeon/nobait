/**
 * Unified settings module tests: defaults, normalization, round-trip,
 * and storage.onChanged live-update wiring.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getSettings,
  saveSettings,
  normalizeSettings,
  mergeSettings,
  onSettingsChanged,
  DEFAULT_SETTINGS,
  CACHE_TTL_MS,
  SETTINGS_KEY,
  type Settings,
} from "../index.js";

interface MockStorageArea {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (obj: Record<string, unknown>) => Promise<void>;
  onChanged: {
    listeners: Array<(changes: unknown, area: string) => void>;
    addListener: (cb: (changes: unknown, area: string) => void) => void;
    removeListener: (cb: (changes: unknown, area: string) => void) => void;
  };
  _store: Map<string, unknown>;
}

function makeStorageArea(
  initial: Record<string, unknown> = {},
): MockStorageArea {
  const store = new Map<string, unknown>(Object.entries(initial));
  const listeners: Array<(changes: unknown, area: string) => void> = [];
  const area: MockStorageArea = {
    _store: store,
    get: async (key: string) => {
      const out: Record<string, unknown> = {};
      if (store.has(key)) out[key] = store.get(key);
      return out;
    },
    set: async (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
      // Fire onChanged like browser.storage does (value-level).
      const changes: Record<string, { newValue?: unknown }> = {};
      for (const k of Object.keys(obj)) {
        changes[k] = { newValue: obj[k] };
      }
      for (const cb of listeners) cb(changes, "local");
    },
    onChanged: {
      listeners,
      addListener: (cb) => listeners.push(cb),
      removeListener: (cb) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
  };
  return area;
}

function installBrowser(area: unknown): void {
  (globalThis as Record<string, unknown>)["browser"] = {
    storage: {
      local: area,
      onChanged: (area as MockStorageArea).onChanged,
    },
  };
}

describe("settings: defaults", () => {
  it("DEFAULT_SETTINGS covers every section", () => {
    const keys = Object.keys(DEFAULT_SETTINGS);
    expect(keys).toContain("ai");
    expect(keys).toContain("stamps");
    expect(keys).toContain("channels");
    expect(keys).toContain("animations");
    expect(keys).toContain("factcheck");
    expect(keys).toContain("thumbnails");
    expect(keys).toContain("debug");
  });

  it("defaults are AI=auto, stamps visible, animations normal", () => {
    expect(DEFAULT_SETTINGS.ai.backend).toBe("auto");
    expect(DEFAULT_SETTINGS.stamps.visible).toBe(true);
    expect(DEFAULT_SETTINGS.animations.intensity).toBe("normal");
    expect(DEFAULT_SETTINGS.thumbnails.cacheTtl).toBe("7d");
  });

  it("CACHE_TTL_MS covers all presets with sane values", () => {
    expect(CACHE_TTL_MS["1h"]).toBe(3_600_000);
    expect(CACHE_TTL_MS["7d"]).toBe(7 * 24 * 3_600_000);
    expect(Object.keys(CACHE_TTL_MS)).toHaveLength(4);
  });
});

describe("settings: normalizeSettings", () => {
  it("returns defaults for garbage input", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back field-by-field on malformed sections", () => {
    const s = normalizeSettings({
      ai: { backend: "telepathy", geminiApiKey: 123 },
      stamps: { visible: "yes", placement: "underneath" },
      channels: { allowlist: "not-a-list", blocklist: [1, "ok", null] },
      animations: { intensity: "ludicrous" },
      thumbnails: { position: { kind: "somewhere" }, cacheTtl: "forever" },
    });
    expect(s.ai.backend).toBe("auto"); // invalid → default
    expect(s.ai.geminiApiKey).toBe("");
    expect(s.stamps.visible).toBe(true);
    expect(s.stamps.placement).toBe("after-title");
    expect(s.channels.allowlist).toEqual([]);
    expect(s.channels.blocklist).toEqual(["ok"]); // filtered to strings
    expect(s.animations.intensity).toBe("normal");
    expect(s.thumbnails.position).toEqual({ kind: "middle" });
    expect(s.thumbnails.cacheTtl).toBe("7d");
  });

  it("clamps percent positions into [0, 1]", () => {
    const high = normalizeSettings({
      thumbnails: { position: { kind: "percent", value: 5 } },
    });
    const low = normalizeSettings({
      thumbnails: { position: { kind: "percent", value: -2 } },
    });
    expect(high.thumbnails.position).toEqual({ kind: "percent", value: 1 });
    expect(low.thumbnails.position).toEqual({ kind: "percent", value: 0 });
  });

  it("preserves valid stored values exactly", () => {
    const stored: Record<string, unknown> = {
      ai: { backend: "ollama", ollamaUrl: "http://localhost:11434" },
      stamps: { visible: false, tiers: { clickbait: false } },
      channels: { allowlist: ["Channel A"] },
      thumbnails: {
        position: { kind: "percent", value: 0.25 },
        cacheTtl: "24h",
      },
    };
    const s = normalizeSettings(stored);
    expect(s.ai.backend).toBe("ollama");
    expect(s.ai.ollamaUrl).toBe("http://localhost:11434");
    expect(s.stamps.visible).toBe(false);
    expect(s.stamps.tiers["clickbait"]).toBe(false);
    expect(s.stamps.tiers["legitimate"]).toBe(true); // unspecified → default on
    expect(s.channels.allowlist).toEqual(["Channel A"]);
    expect(s.thumbnails.position).toEqual({ kind: "percent", value: 0.25 });
    expect(s.thumbnails.cacheTtl).toBe("24h");
  });
});

describe("settings: get/save round-trip", () => {
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

  it("getSettings returns defaults without a browser API", async () => {
    delete (globalThis as Record<string, unknown>)["browser"];
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("getSettings returns defaults when storage is empty", async () => {
    installBrowser(makeStorageArea());
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("saveSettings persists and a subsequent get returns the values", async () => {
    const area = makeStorageArea();
    installBrowser(area);

    await saveSettings({ ai: { backend: "gemini", geminiApiKey: "k-123" } });
    const loaded = await getSettings();

    expect(loaded.ai.backend).toBe("gemini");
    expect(loaded.ai.geminiApiKey).toBe("k-123");
    // Untouched sections keep defaults
    expect(loaded.stamps.visible).toBe(true);
    expect(loaded.animations.intensity).toBe("normal");
  });

  it("partial saves merge without clobbering unrelated fields", async () => {
    const area = makeStorageArea();
    installBrowser(area);

    await saveSettings({ ai: { geminiApiKey: "first" } });
    await saveSettings({ stamps: { visible: false } });
    const loaded = await getSettings();

    expect(loaded.ai.geminiApiKey).toBe("first"); // survived second save
    expect(loaded.stamps.visible).toBe(false);
  });

  it("stores under the documented key", async () => {
    const area = makeStorageArea();
    installBrowser(area);
    await saveSettings({ debug: true });
    expect(area._store.has(SETTINGS_KEY)).toBe(true);
  });

  it("getSettings never throws on corrupt storage reads", async () => {
    const area = makeStorageArea();
    area.get = async () => {
      throw new Error("storage exploded");
    };
    installBrowser(area);
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("settings: mergeSettings", () => {
  it("merges sections without mutating the original", () => {
    const base: Settings = normalizeSettings({});
    const merged = mergeSettings(base, { animations: { intensity: "full" } });
    expect(merged.animations.intensity).toBe("full");
    expect(base.animations.intensity).toBe("normal"); // untouched
  });
});

describe("settings: onSettingsChanged wiring", () => {
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

  it("fires the listener when the settings key changes in local", async () => {
    const area = makeStorageArea();
    installBrowser(area);

    const listener = vi.fn();
    const cast = { onChanged: area.onChanged } as unknown as Parameters<
      typeof onSettingsChanged
    >[1];
    const unsub = onSettingsChanged(listener, cast);

    await saveSettings({ stamps: { visible: false } });

    expect(listener).toHaveBeenCalledTimes(1);
    const firstCall = listener.mock.calls[0] as unknown as [Settings];
    const arg = firstCall[0];
    expect(arg.stamps.visible).toBe(false);
    unsub();
  });

  it("ignores changes to other keys and other areas", async () => {
    const area = makeStorageArea();
    installBrowser(area);

    const listener = vi.fn();
    const cast = { onChanged: area.onChanged } as unknown as Parameters<
      typeof onSettingsChanged
    >[1];
    const unsub = onSettingsChanged(listener, cast);

    // Different area (sync, not local)
    for (const cb of [...area.onChanged.listeners]) {
      cb({ otherKey: { newValue: 1 } }, "sync");
    }
    // Local area but a different key
    for (const cb of [...area.onChanged.listeners]) {
      cb({ someOtherKey: { newValue: 1 } }, "local");
    }

    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it("unsubscribe stops further notifications", async () => {
    const area = makeStorageArea();
    installBrowser(area);

    const listener = vi.fn();
    const cast = { onChanged: area.onChanged } as unknown as Parameters<
      typeof onSettingsChanged
    >[1];
    const unsub = onSettingsChanged(listener, cast);
    unsub();

    await saveSettings({ debug: true });
    expect(listener).not.toHaveBeenCalled();
  });

  it("falls back to the global browser API when no area is passed", async () => {
    const area = makeStorageArea();
    installBrowser(area);

    const listener = vi.fn();
    const unsub = onSettingsChanged(listener);
    await saveSettings({ debug: true });
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("returns a no-op unsubscribe when onChanged is unavailable", () => {
    const unsub = onSettingsChanged(() => {}, undefined);
    expect(() => unsub()).not.toThrow();
  });
});
