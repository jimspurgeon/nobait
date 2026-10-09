/**
 * Options page logic — binds the unified Settings model to the DOM.
 *
 * Sections: AI backend (provider, Gemini key, Ollama URL+model), thumbnail
 * frame position (start/middle/end/random/percent), stamps (visibility,
 * placement, per-tier), animations (toggle + intensity), cache (TTL +
 * clear), channel allow/block lists, fact-check layer.
 *
 * All writes funnel through `saveSettings()` (browser.storage.local) and
 * propagate live to content scripts via storage.onChanged.
 */

import {
  getSettings,
  saveSettings,
  type Settings,
  type DeepPartialSettings,
  type StampPlacement,
  type BackendPreference,
  type AnimationIntensity,
  type ThumbPositionKind,
  CACHE_TTL_MS,
} from "../settings/index";
import type { FramePosition } from "../thumbnail/types";

// `browser` / `chrome` globals come from webextension-polyfill / @types/chrome.
const api =
  typeof browser !== "undefined"
    ? browser
    : typeof chrome !== "undefined"
      ? chrome
      : null;

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setStatus(
  id: string,
  message: string,
  isError = false,
): void {
  const status = el(id);
  if (!status) return;
  status.textContent = message;
  status.classList.add("visible");
  status.classList.toggle("error", isError);
  setTimeout(() => status.classList.remove("visible"), 3000);
}

async function sendMessage(message: Record<string, unknown>): Promise<unknown> {
  if (!api?.runtime?.sendMessage) return null;
  if (typeof browser !== "undefined") {
    return await browser.runtime.sendMessage(message);
  }
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (result: unknown) => resolve(result));
  });
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/**
 * Load persisted settings into the form controls. Called once at boot.
 */
async function loadIntoForm(settings: Settings): Promise<void> {
  // --- AI backend ---
  const backend = el<HTMLSelectElement>("backend");
  if (backend) backend.value = settings.ai.backend;

  const apiKey = el<HTMLInputElement>("api-key");
  if (apiKey && settings.ai.geminiApiKey) {
    apiKey.placeholder = "•••••••••••••••• (saved)";
  }

  const ollamaUrl = el<HTMLInputElement>("ollama-url");
  if (ollamaUrl && settings.ai.ollamaUrl) ollamaUrl.value = settings.ai.ollamaUrl;

  const ollamaModel = el<HTMLInputElement>("ollama-model");
  if (ollamaModel && settings.ai.ollamaModel) {
    ollamaModel.value = settings.ai.ollamaModel;
  }

  // --- Frame position ---
  const framePos = el<HTMLSelectElement>("frame-position");
  const percentContainer = el("percent-slider-container");
  const percentSlider = el<HTMLInputElement>("percent-value");
  const percentOutput = el<HTMLOutputElement>("percent-output");

  if (framePos) {
    framePos.value = settings.thumbnails.position.kind;
    if (percentContainer) {
      percentContainer.classList.toggle(
        "hidden",
        settings.thumbnails.position.kind !== "percent",
      );
    }
    if (percentSlider && settings.thumbnails.position.kind === "percent") {
      const pct = Math.round(settings.thumbnails.position.value * 100);
      percentSlider.value = String(pct);
      if (percentOutput) percentOutput.textContent = `${pct}%`;
    }
  }

  // --- Stamps ---
  const stampsVisible = el<HTMLInputElement>("stamps-visible");
  if (stampsVisible) stampsVisible.checked = settings.stamps.visible;

  const placement = el<HTMLSelectElement>("stamp-placement");
  if (placement) placement.value = settings.stamps.placement;

  document
    .querySelectorAll<HTMLInputElement>('input[data-tier]')
    .forEach((cb) => {
      const tier = cb.dataset.tier;
      if (tier) cb.checked = settings.stamps.tiers[tier] !== false;
    });

  // --- Animations ---
  const animEnabled = el<HTMLInputElement>("animations-enabled");
  if (animEnabled) animEnabled.checked = settings.animations.enabled;

  const intensity = el<HTMLSelectElement>("anim-intensity");
  if (intensity) intensity.value = settings.animations.intensity;

  // --- Cache ---
  const cacheTtl = el<HTMLSelectElement>("cache-ttl");
  if (cacheTtl) cacheTtl.value = settings.thumbnails.cacheTtl;

  // --- Channels ---
  renderTagList("allowlist", settings.channels.allowlist);
  renderTagList("blocklist", settings.channels.blocklist);

  // --- Fact-check ---
  const fcEnabled = el<HTMLInputElement>("factcheck-enabled");
  if (fcEnabled) fcEnabled.checked = settings.factcheck.enabled;

  const fcKey = el<HTMLInputElement>("factcheck-api-key");
  if (fcKey && settings.factcheck.apiKey) {
    fcKey.placeholder = "•••••••••••••••• (saved)";
  }
}

/**
 * Read current form state into a settings update object.
 */
function collectFormState(): DeepPartialSettings {
  const update: DeepPartialSettings = {};

  const backend = el<HTMLSelectElement>("backend");
  if (backend) {
    update.ai = {
      backend: backend.value as BackendPreference,
    };
  }

  const apiKey = el<HTMLInputElement>("api-key");
  if (apiKey && apiKey.value.trim()) {
    update.ai = { ...update.ai, geminiApiKey: apiKey.value.trim() };
  }

  const ollamaUrl = el<HTMLInputElement>("ollama-url");
  if (ollamaUrl) {
    update.ai = { ...update.ai, ollamaUrl: ollamaUrl.value.trim() };
  }

  const ollamaModel = el<HTMLInputElement>("ollama-model");
  if (ollamaModel) {
    update.ai = { ...update.ai, ollamaModel: ollamaModel.value.trim() };
  }

  const framePos = el<HTMLSelectElement>("frame-position");
  const percentSlider = el<HTMLInputElement>("percent-value");
  let position: FramePosition | undefined;
  if (framePos) {
    const kind = framePos.value as ThumbPositionKind;
    if (kind === "percent" && percentSlider) {
      position = { kind: "percent", value: Number(percentSlider.value) / 100 };
    } else if (
      kind === "start" ||
      kind === "middle" ||
      kind === "end" ||
      kind === "random"
    ) {
      position = { kind };
    }
  }
  if (position) {
    update.thumbnails = { ...update.thumbnails, position };
  }

  const stampsVisible = el<HTMLInputElement>("stamps-visible");
  if (stampsVisible) {
    update.stamps = { ...update.stamps, visible: stampsVisible.checked };
  }

  const placement = el<HTMLSelectElement>("stamp-placement");
  if (placement) {
    update.stamps = {
      ...update.stamps,
      placement: placement.value as StampPlacement,
    };
  }

  const tiers: Record<string, boolean> = {};
  document
    .querySelectorAll<HTMLInputElement>('input[data-tier]')
    .forEach((cb) => {
      const tier = cb.dataset.tier;
      if (tier) tiers[tier] = cb.checked;
    });
  update.stamps = { ...update.stamps, tiers };

  const animEnabled = el<HTMLInputElement>("animations-enabled");
  if (animEnabled) {
    update.animations = { ...update.animations, enabled: animEnabled.checked };
  }

  const intensity = el<HTMLSelectElement>("anim-intensity");
  if (intensity) {
    update.animations = {
      ...update.animations,
      intensity: intensity.value as AnimationIntensity,
    };
  }

  const cacheTtl = el<HTMLSelectElement>("cache-ttl");
  if (cacheTtl) {
    const ttl = cacheTtl.value as keyof typeof CACHE_TTL_MS;
    if (ttl in CACHE_TTL_MS) {
      update.thumbnails = { ...update.thumbnails, cacheTtl: ttl };
    }
  }

  update.channels = {
    allowlist: [...allowTags],
    blocklist: [...blockTags],
  };

  const fcEnabled = el<HTMLInputElement>("factcheck-enabled");
  if (fcEnabled) {
    update.factcheck = { ...update.factcheck, enabled: fcEnabled.checked };
  }

  const fcKey = el<HTMLInputElement>("factcheck-api-key");
  if (fcKey && fcKey.value.trim()) {
    update.factcheck = { ...update.factcheck, apiKey: fcKey.value.trim() };
  }

  return update;
}

// ---------------------------------------------------------------------------
// Channel tag lists (mutable working copies)
// ---------------------------------------------------------------------------

let allowTags = new Set<string>();
let blockTags = new Set<string>();

function renderTagList(kind: "allowlist" | "blocklist", items: string[]): void {
  const container = el(`${kind}-tags`);
  if (!container) return;
  container.textContent = "";
  const set = kind === "allowlist" ? allowTags : blockTags;
  set.clear();
  for (const item of items) {
    set.add(item);
    container.appendChild(buildTagChip(kind, item));
  }
}

function buildTagChip(kind: "allowlist" | "blocklist", item: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "tag";
  chip.textContent = item;

  const remove = document.createElement("button");
  remove.textContent = "×";
  remove.setAttribute("aria-label", `Remove ${item}`);
  remove.addEventListener("click", () => {
    const set = kind === "allowlist" ? allowTags : blockTags;
    set.delete(item);
    chip.remove();
    void saveChannels();
  });
  chip.appendChild(remove);
  return chip;
}

async function addTag(
  kind: "allowlist" | "blocklist",
  rawValue: string,
): Promise<void> {
  const value = rawValue.trim();
  if (!value) return;
  const set = kind === "allowlist" ? allowTags : blockTags;
  set.add(value);
  const container = el(`${kind}-tags`);
  container?.appendChild(buildTagChip(kind, value));
  await saveChannels();
}

async function saveChannels(): Promise<void> {
  await saveSettings(collectFormState());
  setStatus("channel-status", "Channel lists saved.");
}

// ---------------------------------------------------------------------------
// Wire up handlers
// ---------------------------------------------------------------------------

function wireEvents(): void {
  // Show/hide the percent slider when frame-position changes.
  el<HTMLSelectElement>("frame-position")?.addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    const container = el("percent-slider-container");
    container?.classList.toggle("hidden", sel.value !== "percent");
  });

  el<HTMLInputElement>("percent-value")?.addEventListener("input", (e) => {
    const slider = e.target as HTMLInputElement;
    const out = el<HTMLOutputElement>("percent-output");
    if (out) out.textContent = `${slider.value}%`;
  });

  // --- Buttons (explicit save per section) ---
  el("save-ai")?.addEventListener("click", async () => {
    const update = collectFormState();
    await saveSettings({ ai: update.ai });
    setStatus("ai-status", "AI settings saved.");
    const apiKey = el<HTMLInputElement>("api-key");
    if (apiKey && apiKey.value) {
      apiKey.value = "";
      apiKey.placeholder = "•••••••••••••••• (saved)";
    }
    await updateProviderBadge();
  });

  el("save-stamps")?.addEventListener("click", async () => {
    const update = collectFormState();
    await saveSettings({ stamps: update.stamps });
    setStatus("stamp-status", "Stamp settings saved.");
  });

  el("clear-cache")?.addEventListener("click", async () => {
    try {
      const result = (await sendMessage({ type: "CLEAR_CACHE" })) as {
        success?: boolean;
      };
      if (result && result.success === false) {
        setStatus("cache-status", "Failed to clear cache.", true);
      } else {
        setStatus("cache-status", "Cache cleared.");
      }
    } catch (err) {
      setStatus("cache-status", `Failed to clear cache: ${String(err)}`, true);
    }
  });

  el("add-allowlist")?.addEventListener("click", () => {
    const input = el<HTMLInputElement>("allowlist-input");
    if (input) {
      void addTag("allowlist", input.value);
      input.value = "";
    }
  });

  el("allowlist-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const input = e.target as HTMLInputElement;
      void addTag("allowlist", input.value);
      input.value = "";
    }
  });

  el("add-blocklist")?.addEventListener("click", () => {
    const input = el<HTMLInputElement>("blocklist-input");
    if (input) {
      void addTag("blocklist", input.value);
      input.value = "";
    }
  });

  el("blocklist-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const input = e.target as HTMLInputElement;
      void addTag("blocklist", input.value);
      input.value = "";
    }
  });

  el("save-channels")?.addEventListener("click", async () => {
    await saveChannels();
  });

  el("save-factcheck")?.addEventListener("click", async () => {
    const update = collectFormState();
    await saveSettings({ factcheck: update.factcheck });
    setStatus("factcheck-status", "Fact check settings saved.");
    const fcKey = el<HTMLInputElement>("factcheck-api-key");
    if (fcKey && fcKey.value) {
      fcKey.value = "";
      fcKey.placeholder = "•••••••••••••••• (saved)";
    }
  });

  // --- Instant-apply controls (no button) ---
  el<HTMLSelectElement>("frame-position")?.addEventListener("change", () => {
    void saveSettings({ thumbnails: collectFormState().thumbnails });
  });

  el("percent-value")?.addEventListener("change", () => {
    void saveSettings({ thumbnails: collectFormState().thumbnails });
  });

  el<HTMLInputElement>("stamps-visible")?.addEventListener("change", () => {
    void saveSettings({ stamps: collectFormState().stamps });
  });

  el<HTMLSelectElement>("stamp-placement")?.addEventListener("change", () => {
    void saveSettings({ stamps: collectFormState().stamps });
  });

  document
    .querySelectorAll<HTMLInputElement>('input[data-tier]')
    .forEach((cb) => {
      cb.addEventListener("change", () => {
        void saveSettings({ stamps: collectFormState().stamps });
      });
    });

  el<HTMLInputElement>("animations-enabled")?.addEventListener("change", () => {
    void saveSettings({ animations: collectFormState().animations });
  });

  el<HTMLSelectElement>("anim-intensity")?.addEventListener("change", () => {
    void saveSettings({ animations: collectFormState().animations });
  });

  el<HTMLSelectElement>("cache-ttl")?.addEventListener("change", () => {
    void saveSettings({ thumbnails: collectFormState().thumbnails });
  });
}

/**
 * Update the "Currently using: X" hint below AI settings. Mirrors the factory
 * priority chain for display purposes.
 */
async function updateProviderBadge(): Promise<void> {
  const strong = el("current-provider");
  if (!strong) return;
  const settings = await getSettings();
  if (settings.ai.backend !== "auto") {
    strong.textContent =
      settings.ai.backend === "chrome"
        ? "Chrome built-in (forced)"
        : settings.ai.backend === "gemini"
          ? "Gemini (forced)"
          : settings.ai.backend === "ollama"
            ? "Ollama (forced)"
            : "Unknown";
    return;
  }
  // Auto: chain order per factory.ts
  if (settings.ai.geminiApiKey) {
    strong.textContent = "Gemini (auto — key set)";
  } else if (settings.ai.ollamaUrl) {
    strong.textContent = "Ollama (auto — local URL set)";
  } else {
    strong.textContent = "None configured";
  }
}

async function init(): Promise<void> {
  const settings = await getSettings();
  allowTags = new Set(settings.channels.allowlist);
  blockTags = new Set(settings.channels.blocklist);
  await loadIntoForm(settings);
  wireEvents();
  await updateProviderBadge();
}

init().catch(console.error);
