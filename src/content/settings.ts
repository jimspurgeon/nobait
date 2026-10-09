/**
 * Settings persistence — `browser.storage.local` with sensible defaults
 * and graceful degradation when the API is unavailable (e.g. unit tests
 * or non-extension contexts).
 */

import { DEFAULT_THUMB_CONFIG, type FramePosition } from "../thumbnail/types";
import { webext } from "../utils/webext";

export interface NobaitSettings {
  thumbnailPosition: FramePosition;
  debug: boolean;
}

export const DEFAULT_SETTINGS: NobaitSettings = {
  thumbnailPosition: DEFAULT_THUMB_CONFIG.position,
  debug: false,
};

function posFromRaw(raw: unknown): FramePosition {
  if (raw && typeof raw === "object" && "kind" in raw) {
    const v = raw as FramePosition;
    switch (v.kind) {
      case "start":
      case "middle":
      case "end":
      case "random":
        return { kind: v.kind };
      case "percent":
        return { kind: "percent", value: Number(v.value) || 0.5 };
    }
  }
  return DEFAULT_SETTINGS.thumbnailPosition;
}

export async function loadSettings(): Promise<NobaitSettings> {
  try {
    const area = webext.storage?.local;
    const stored = (await area?.get(["settings"])) ?? {};
    const raw = (stored.settings ?? {}) as Record<string, unknown>;
    return {
      thumbnailPosition: posFromRaw(raw.thumbnailPosition),
      debug: Boolean(raw.debug),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
