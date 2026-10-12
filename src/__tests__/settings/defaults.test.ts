/**
 * Settings defaults & normalization tests (Slices 2-3).
 *
 * Pins the out-of-box contract: smollm2-135m as the default built-in model
 * (88 MB, fast first run), status chip on by default, and per-field
 * fallback for malformed stored values.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  mergeSettings,
} from "../../settings/index";

describe("DEFAULT_SETTINGS (out-of-box UX)", () => {
  it("defaults to the smollm2-135m built-in model", () => {
    expect(DEFAULT_SETTINGS.ai.builtinModel).toBe("smollm2-135m");
  });

  it("shows the status chip by default", () => {
    expect(DEFAULT_SETTINGS.ui.showStatusChip).toBe(true);
  });
});

describe("normalizeSettings", () => {
  it("absent stored settings yield defaults", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("malformed ui section falls back field-by-field", () => {
    const out = normalizeSettings({ ui: { showStatusChip: "yes" } });
    expect(out.ui.showStatusChip).toBe(true); // non-boolean → default
  });

  it("stored ui override is respected", () => {
    const out = normalizeSettings({ ui: { showStatusChip: false } });
    expect(out.ui.showStatusChip).toBe(false);
  });

  it("unknown builtinModel falls back to the smollm2 default", () => {
    const out = normalizeSettings({ ai: { builtinModel: "gpt-4" } });
    expect(out.ai.builtinModel).toBe("smollm2-135m");
  });

  it("valid legacy qwen selection survives normalization", () => {
    // Users who explicitly picked Qwen keep it after the default switch.
    const out = normalizeSettings({ ai: { builtinModel: "qwen2.5-0.5b" } });
    expect(out.ai.builtinModel).toBe("qwen2.5-0.5b");
  });
});

describe("mergeSettings", () => {
  it("merges the ui section without clobbering others", () => {
    const current = DEFAULT_SETTINGS;
    const next = mergeSettings(current, { ui: { showStatusChip: false } });
    expect(next.ui.showStatusChip).toBe(false);
    expect(next.ai.builtinModel).toBe(current.ai.builtinModel);
    expect(next.stamps.visible).toBe(current.stamps.visible);
  });
});
