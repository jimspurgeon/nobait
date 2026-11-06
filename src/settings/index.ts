/**
 * Unified nobait settings: a single typed `Settings` object persisted in
 * `browser.storage.local` under `SETTINGS_KEY`, with safe defaults and
 * strict validation on read (malformed values fall back field-by-field).
 *
 * Both the options page and content/background scripts consume
 * {@link getSettings}. Live updates propagate via `browser.storage.onChanged`
 * (see `onSettingsChanged`).
 *
 * Legacy migrations absorbed here:
 * - P3 options keys (`preferredBackend`, `geminiApiKey`) → `ai` section.
 * - P6 fact-check settings (`nobait:factcheck-settings`) → `factcheck` section
 *   (read-side compat is retained in `factcheck-settings.ts`).
 */

import type { FramePosition } from "../thumbnail/types";
import type { BuiltinModelId } from "../ai/wasm";

/** Storage key holding the whole settings object. */
export const SETTINGS_KEY = "nobait:settings";

/** Where the AI picks a frame from within the video. */
export type ThumbPositionKind =
  "start" | "middle" | "end" | "random" | "percent";

/** Which AI provider to use. `auto` follows the factory priority chain. */
export type BackendPreference =
  "auto" | "chrome" | "gemini" | "ollama" | "builtin";

/** Placement of stamp badges relative to the video title. */
export type StampPlacement = "after-title" | "before-title";

/** Animation intensity for the P5 delight layer. */
export type AnimationIntensity = "off" | "subtle" | "normal" | "full";

/** Cache entry time-to-live. */
export type CacheTTL = "1h" | "24h" | "7d" | "30d";

/** Milliseconds per TTL preset (positive cache). */
export const CACHE_TTL_MS: Readonly<Record<CacheTTL, number>> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** AI backend configuration section. */
export interface AISettings {
  /** Preferred provider; `auto` = factory chain (Chrome → Gemini → Ollama). */
  backend: BackendPreference;
  /** Gemini API key (empty = unset). */
  geminiApiKey: string;
  /** Ollama / local OpenAI-compatible base URL (empty = unset). */
  ollamaUrl: string;
  /** Model tag for the local endpoint (e.g. "qwen3:0.6b"). */
  ollamaModel: string;
  /** Which built-in WASM model to use (catalogue key, see ai/wasm.ts). */
  builtinModel: BuiltinModelId;
}

/** Stamp display configuration section. */
export interface StampSettings {
  /** Master visibility toggle. */
  visible: boolean;
  /** Position relative to the title. */
  placement: StampPlacement;
  /** Per-tier visibility (shape-distinct glyph + color pairs). */
  tiers: Readonly<Record<string, boolean>>;
}

/** Per-channel treatment. */
export interface ChannelSettings {
  /** Channels exempt from rewriting/stamping (keep originals). */
  allowlist: string[];
  /** Channels whose videos are always aggressively flagged. */
  blocklist: string[];
}

/** Animation configuration section. */
export interface AnimationSettings {
  /** Master toggle. Off collapses everything to instant swaps. */
  enabled: boolean;
  /** Relative strength of the P5 effects. */
  intensity: AnimationIntensity;
}

/** Fact-check (ClaimReview) layer section. */
export interface FactCheckSettingsSection {
  /** Layer enabled. */
  enabled: boolean;
  /** Google Fact Check Tools API key (empty = unset). */
  apiKey: string;
}

/** UI configuration section. */
export interface UISettings {
  /** Show status chip on YouTube pages (download progress, AI status, thumb stats). */
  showStatusChip: boolean;
}

/** The whole persisted settings object. */
export interface Settings {
  ai: AISettings;
  stamps: StampSettings;
  channels: ChannelSettings;
  animations: AnimationSettings;
  factcheck: FactCheckSettingsSection;
  thumbnails: {
    /** Where inside the video to source the replacement frame. */
    position: FramePosition;
    /** Positive-cache TTL preset. */
    cacheTtl: CacheTTL;
  };
  ui: UISettings;
  debug: boolean;
}

/** Default per-tier stamp visibility (all on). */
const DEFAULT_TIERS: Readonly<Record<string, boolean>> = Object.freeze({
  legitimate: true,
  exaggerated: true,
  misleading: true,
  clickbait: true,
  fake: true,
  unsure: true,
});

/** Factory defaults — used when nothing (or a field) is stored. */
export const DEFAULT_SETTINGS: Settings = {
  ai: {
    backend: "auto",
    geminiApiKey: "",
    ollamaUrl: "",
    ollamaModel: "",
    builtinModel: "smollm2-135m",
  },
  stamps: {
    visible: true,
    placement: "after-title",
    tiers: DEFAULT_TIERS,
  },
  channels: {
    allowlist: [],
    blocklist: [],
  },
  animations: {
    enabled: true,
    intensity: "normal",
  },
  factcheck: {
    enabled: true,
    apiKey: "",
  },
  thumbnails: {
    position: { kind: "middle" },
    cacheTtl: "7d",
  },
  ui: {
    showStatusChip: true,
  },
  debug: false,
};

/**
 * Resolve the WebExtensions API namespace portably (Firefox `browser`,
 * Chrome `chrome`), tolerating absence (unit tests, non-extension pages).
 */
interface StorageAreaLocal {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (obj: Record<string, unknown>) => Promise<void>;
}

interface BrowserLike {
  storage?: {
    local?: StorageAreaLocal;
    onChanged?: {
      addListener?: (cb: (changes: unknown, area: string) => void) => void;
      removeListener?: (cb: (changes: unknown, area: string) => void) => void;
    };
    sync?: unknown;
  };
  runtime?: Record<string, unknown>;
}

function browserAPI(): BrowserLike | undefined {
  const g = globalThis as Record<string, unknown>;
  return (g["browser"] ?? g["chrome"]) as BrowserLike | undefined;
}

/** Deep-ish clone via structured clone (settings are plain JSON data). */
function clone<T>(value: T): T {
  return structuredClone(value);
}

// ---------------------------------------------------------------------------
// Validation helpers (fall back field-by-field, never throw)
// ---------------------------------------------------------------------------

function asEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

function asString(raw: unknown, fallback: string): string {
  return typeof raw === "string" ? raw : fallback;
}

function asBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function asStringList(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback;
  return raw.filter((v): v is string => typeof v === "string");
}

function parseFramePosition(raw: unknown): FramePosition {
  if (raw && typeof raw === "object" && "kind" in raw) {
    const v = raw as { kind: unknown; value?: unknown };
    switch (v.kind) {
      case "start":
      case "middle":
      case "end":
      case "random":
        return { kind: v.kind };
      case "percent":
        return {
          kind: "percent",
          value:
            typeof v.value === "number" && Number.isFinite(v.value)
              ? Math.min(1, Math.max(0, v.value))
              : 0.5,
        };
    }
  }
  return clone(DEFAULT_SETTINGS.thumbnails.position);
}

function parseTiers(raw: unknown): Readonly<Record<string, boolean>> {
  if (!raw || typeof raw !== "object") return DEFAULT_TIERS;
  const src = raw as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const tier of Object.keys(DEFAULT_TIERS)) {
    const v = src[tier];
    out[tier] = typeof v === "boolean" ? v : true;
  }
  return out;
}

/**
 * Validate a raw object (possibly malformed) into a fully-formed
 * `Settings`, filling gaps with defaults. Never throws.
 */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const ai = (r["ai"] ?? {}) as Record<string, unknown>;
  const stamps = (r["stamps"] ?? {}) as Record<string, unknown>;
  const channels = (r["channels"] ?? {}) as Record<string, unknown>;
  const animations = (r["animations"] ?? {}) as Record<string, unknown>;
  const factcheck = (r["factcheck"] ?? {}) as Record<string, unknown>;
  const thumbnails = (r["thumbnails"] ?? {}) as Record<string, unknown>;
  const ui = (r["ui"] ?? {}) as Record<string, unknown>;

  return {
    ai: {
      backend: asEnum(
        ai["backend"],
        ["auto", "chrome", "gemini", "ollama", "builtin"],
        DEFAULT_SETTINGS.ai.backend,
      ),
      geminiApiKey: asString(ai["geminiApiKey"], ""),
      ollamaUrl: asString(ai["ollamaUrl"], ""),
      ollamaModel: asString(ai["ollamaModel"], ""),
      builtinModel: asEnum(
        ai["builtinModel"],
        ["qwen2.5-0.5b", "smollm2-360m", "smollm2-135m"] as const,
        DEFAULT_SETTINGS.ai.builtinModel,
      ),
    },
    stamps: {
      visible: asBool(stamps["visible"], true),
      placement: asEnum(
        stamps["placement"],
        ["after-title", "before-title"],
        DEFAULT_SETTINGS.stamps.placement,
      ),
      tiers: parseTiers(stamps["tiers"]),
    },
    channels: {
      allowlist: asStringList(channels["allowlist"], []),
      blocklist: asStringList(channels["blocklist"], []),
    },
    animations: {
      enabled: asBool(animations["enabled"], true),
      intensity: asEnum(
        animations["intensity"],
        ["off", "subtle", "normal", "full"],
        DEFAULT_SETTINGS.animations.intensity,
      ),
    },
    factcheck: {
      enabled: asBool(factcheck["enabled"], true),
      apiKey: asString(factcheck["apiKey"], ""),
    },
    thumbnails: {
      position: parseFramePosition(thumbnails["position"]),
      cacheTtl: asEnum(
        thumbnails["cacheTtl"],
        ["1h", "24h", "7d", "30d"],
        DEFAULT_SETTINGS.thumbnails.cacheTtl,
      ),
    },
    ui: {
      showStatusChip: asBool(ui["showStatusChip"], true),
    },
    debug: asBool(r["debug"], false),
  };
}

/**
 * Read settings from `browser.storage.local`, normalized against defaults.
 * Absent storage (tests, non-extension contexts) yields defaults.
 */
export async function getSettings(): Promise<Settings> {
  try {
    const api = browserAPI();
    const area = api?.storage?.local;
    if (typeof area?.get !== "function") return clone(DEFAULT_SETTINGS);
    const bag = (await area.get(SETTINGS_KEY)) ?? {};
    const raw = (bag as Record<string, unknown>)[SETTINGS_KEY];
    return normalizeSettings(raw);
  } catch (err) {
    console.warn("[nobait] Failed to read settings:", err);
    return clone(DEFAULT_SETTINGS);
  }
}

/**
 * Persist a settings update. Accepts a partial — it is merged over the
 * current stored settings (deep merge per section) before writing, so
 * callers never clobber unrelated fields.
 */
export async function saveSettings(
  update: DeepPartialSettings,
): Promise<Settings> {
  const current = await getSettings();
  const next = mergeSettings(current, update);
  try {
    const api = browserAPI();
    const area = api?.storage?.local;
    if (typeof area?.set === "function") {
      await area.set({ [SETTINGS_KEY]: next });
    }
  } catch (err) {
    console.warn("[nobait] Failed to write settings:", err);
  }
  return next;
}

/** Partial variant of {@link Settings} for updates. */
export type DeepPartialSettings = {
  [K in keyof Settings]?: Settings[K] extends object
    ? Partial<Settings[K]>
    : Settings[K];
};

/** Deep-merge an update over current settings (sections replaced wholesale). */
export function mergeSettings(
  current: Settings,
  update: DeepPartialSettings,
): Settings {
  return {
    ai: { ...current.ai, ...(update.ai ?? {}) },
    stamps: { ...current.stamps, ...(update.stamps ?? {}) },
    channels: { ...current.channels, ...(update.channels ?? {}) },
    animations: { ...current.animations, ...(update.animations ?? {}) },
    factcheck: { ...current.factcheck, ...(update.factcheck ?? {}) },
    thumbnails: { ...current.thumbnails, ...(update.thumbnails ?? {}) },
    ui: { ...current.ui, ...(update.ui ?? {}) },
    debug: update.debug ?? current.debug,
  };
}

/**
 * Subscribe to settings changes (live-apply). Storage area is passed as a
 * parameter for testability; defaults to the global API's.
 *
 * @returns an unsubscribe function.
 */
export function onSettingsChanged(
  listener: (settings: Settings) => void,
  storageArea?: {
    onChanged?: {
      addListener?: (
        cb: (
          changes: Record<string, { newValue?: unknown }>,
          area: string,
        ) => void,
      ) => void;
      removeListener?: (cb: (changes: unknown, area: string) => void) => void;
    };
  },
): () => void {
  const area = storageArea ?? browserAPI()?.storage;
  const onChanged = area?.onChanged;
  if (!onChanged?.addListener) return () => {};

  const handler = (rawChanges: unknown, areaName: string) => {
    if (areaName !== "local") return;
    const changes = rawChanges as Record<string, { newValue?: unknown }>;
    if (!(SETTINGS_KEY in changes)) return;
    listener(normalizeSettings(changes[SETTINGS_KEY]?.newValue));
  };

  onChanged.addListener(handler);
  return () => {
    onChanged.removeListener?.(handler);
  };
}
