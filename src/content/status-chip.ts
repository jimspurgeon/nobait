/**
 * Status chip: fixed-position indicator (bottom-right) showing download
 * progress, AI provider status, and thumbnail pipeline stats. Respects
 * `ui.showStatusChip` setting; dismissable for the session.
 */

import type { ThumbBatchStats } from "../thumbnail/index";

export interface ChipState {
  phase: "download" | "ready" | "error";
  progress?: number; // 0-100 during download
  thumbStats?: ThumbBatchStats;
  errorMessage?: string;
}

let chipEl: HTMLDivElement | null = null;
let dismissedForSession = false;

/** Create and inject the status chip element. */
export function showStatusChip(initialState?: ChipState): void {
  if (dismissedForSession || document.querySelector(".nobait-status-chip")) {
    return;
  }
  chipEl = document.createElement("div");
  chipEl.className = "nobait-status-chip";
  chipEl.style.cssText =
    "position:fixed;bottom:16px;right:16px;padding:8px 12px;background:#1f1f1f;color:#fff;font-size:12px;border-radius:6px;" +
    "display:flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(0,0,0,0.3);" +
    "z-index:9999;transition:opacity 0.2s ease,transform 0.2s ease;";

  const textEl = document.createElement("span");
  textEl.style.flex = "1";
  chipEl.appendChild(textEl);

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.style.cssText =
    "background:none;border:none;color:#aaa;font-size:16px;cursor:pointer;padding:0 0 0 8px;";
  closeBtn.onclick = () => {
    dismissedForSession = true;
    chipEl?.remove();
    chipEl = null;
  };
  chipEl.appendChild(closeBtn);

  // Content scripts run at document_start — body may not exist yet
  // (same trap as the observer setup in content/index.ts). Defer mounting
  // to DOMContentLoaded rather than throwing and killing main().
  if (document.body) {
    document.body.appendChild(chipEl);
  } else {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        if (chipEl && !chipEl.isConnected) document.body?.appendChild(chipEl);
      },
      { once: true },
    );
  }
  updateChipState(initialState ?? { phase: "ready" });
}

/** Update the chip display based on current state. */
export function updateChipState(state: ChipState): void {
  if (!chipEl && !dismissedForSession) {
    // Chip not yet shown — show it unless the user already dismissed it.
    showStatusChip(state);
    if (!chipEl) return;
  }
  if (!chipEl) return;

  const textEl = chipEl.querySelector("span");
  if (!textEl) return;

  switch (state.phase) {
    case "download":
      textEl.textContent = `nobait ⬇ ${state.progress ?? 0}%`;
      chipEl.style.color = "#fff";
      chipEl.style.opacity = "0.9";
      break;
    case "ready":
      textEl.textContent = "nobait ✓";
      chipEl.style.color = "#fff";
      chipEl.style.opacity = "1";
      break;
    case "error":
      textEl.textContent = `nobait ✗ ${state.errorMessage ?? "init failed"}`;
      chipEl.style.color = "#ff6b6b";
      break;
  }
}

/** Hide the chip programmatically (e.g. when settings.showStatusChip becomes false). */
export function hideStatusChip(): void {
  chipEl?.remove();
  chipEl = null;
}
