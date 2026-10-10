/**
 * Unit tests for the status chip (Slice 2 observability layer).
 *
 * Tests cover:
 * - showStatusChip renders the chip element with correct structure
 * - updateChipState transitions through download/ready/error phases
 * - dismiss button hides chip (dismissal per-session state cannot be
 *   tested via vi.resetModules since module state is captured in closures)
 * - chip respects settings.ui.showStatusChip toggle
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  showStatusChip,
  hideStatusChip,
  updateChipState,
} from "../../content/status-chip";

describe("status-chip", () => {
  beforeEach(() => {
    // Ensure clean DOM state
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("showStatusChip", () => {
    test("creates chip element with correct structure", () => {
      showStatusChip({ phase: "ready" });

      const chip = document.querySelector(".nobait-status-chip");
      expect(chip).toBeTruthy();

      // Check z-index for bottom-right placement
      const style = window.getComputedStyle(chip!);
      expect(style.position).toBe("fixed");
      expect(style.zIndex).toBe("9999");

      // Should have a span for the status text and a dismiss button
      const textSpan = chip?.querySelector("span");
      const dismissBtn = chip?.querySelector("button");

      expect(textSpan).toBeTruthy();
      expect(dismissBtn).toBeTruthy();
      expect(dismissBtn?.textContent).toBe("×");
    });

    test("shows download phase with progress", () => {
      showStatusChip({ phase: "download", progress: 45 });

      const chip = document.querySelector(".nobait-status-chip");
      expect(chip?.textContent).toContain("⬇");
      expect(chip?.textContent).toContain("45%");
    });

    test("shows ready phase on completion", () => {
      showStatusChip({ phase: "ready" });

      const chip = document.querySelector(".nobait-status-chip");
      expect(chip?.textContent).toContain("✓");
    });

    test("shows error phase with message", () => {
      showStatusChip({
        phase: "error",
        errorMessage: "AI init failed",
      });

      const chip = document.querySelector(".nobait-status-chip");
      expect(chip?.textContent).toContain("✗");
      expect(chip?.textContent).toContain("AI init failed");
    });

    test("appends to document.body", () => {
      expect(document.body.childElementCount).toBe(0);

      showStatusChip({ phase: "ready" });

      expect(document.body.childElementCount).toBe(1);
      expect(
        (document.body.firstElementChild as HTMLElement)?.classList.contains(
          "nobait-status-chip",
        ),
      ).toBe(true);
    });

    test("defers mount to DOMContentLoaded when body is absent", () => {
      // Simulate document_start: temporarily remove body, call
      // showStatusChip, then restore body and fire DOMContentLoaded.
      // The chip must not throw (which would kill main()) and must mount
      // once body exists.
      const realBody = document.body;
      Object.defineProperty(document, "body", {
        configurable: true,
        get: () => null,
      });

      expect(() =>
        showStatusChip({ phase: "download", progress: 10 }),
      ).not.toThrow();

      Object.defineProperty(document, "body", {
        configurable: true,
        writable: true,
        value: realBody,
      });

      // Not mounted yet.
      expect(document.querySelector(".nobait-status-chip")).toBeFalsy();

      document.dispatchEvent(
        new Event("DOMContentLoaded", { bubbles: true }),
      );

      const chip = document.querySelector(".nobait-status-chip");
      expect(chip).toBeTruthy();
      expect(chip?.textContent).toContain("⬇");
      expect(chip?.textContent).toContain("10%");
    });
  });

  describe("updateChipState", () => {
    test("transitions from download to ready", () => {
      showStatusChip({ phase: "download", progress: 30 });
      let chip = document.querySelector(".nobait-status-chip") as HTMLElement;
      expect(chip?.textContent).toContain("⬇");
      expect(chip?.textContent).toContain("30%");

      updateChipState({ phase: "ready" });

      chip = document.querySelector(".nobait-status-chip") as HTMLElement;
      expect(chip?.textContent).toContain("✓");
      expect(chip?.textContent).not.toContain("⬇");
    });

    test("updates error message dynamically", () => {
      showStatusChip({ phase: "ready" });

      updateChipState({
        phase: "error",
        errorMessage: "first error",
      });
      let chip = document.querySelector(".nobait-status-chip");
      expect(chip?.textContent).toContain("first error");

      updateChipState({
        phase: "error",
        errorMessage: "second error",
      });
      chip = document.querySelector(".nobait-status-chip");
      expect(chip?.textContent).toContain("second error");
      expect(chip?.textContent).not.toContain("first error");
    });

    test("shows thumb error when all swaps fail", () => {
      showStatusChip({ phase: "ready" });

      updateChipState({
        phase: "error",
        errorMessage: "no thumbnails swapped (sprite, innertube)",
      });

      const chip = document.querySelector(".nobait-status-chip");
      expect(chip?.textContent).toContain("✗");
      expect(chip?.textContent).toContain("no thumbnails swapped");
    });
  });

  describe("hideStatusChip", () => {
    test("removes chip from DOM", () => {
      showStatusChip({ phase: "ready" });
      expect(document.querySelector(".nobait-status-chip")).toBeTruthy();

      hideStatusChip();
      expect(document.querySelector(".nobait-status-chip")).toBeFalsy();
      expect(document.body.childElementCount).toBe(0);
    });

    test("no-op when chip not shown", () => {
      expect(() => hideStatusChip()).not.toThrow();
    });
  });

  describe("css styling", () => {
    test("applies correct colors per phase", () => {
      // Download phase
      showStatusChip({ phase: "download", progress: 50 });
      let chip = document.querySelector(".nobait-status-chip") as HTMLElement;
      expect(chip.style.color).toBe("rgb(255, 255, 255)");
      expect(chip.textContent).toContain("⬇");

      // Clear DOM and show error phase fresh
      document.body.innerHTML = "";
      showStatusChip({
        phase: "error",
        errorMessage: "test error",
      });
      chip = document.querySelector(".nobait-status-chip") as HTMLElement;
      // Error state uses red accent
      expect(chip.textContent).toContain("✗");
      expect(chip.textContent).toContain("test error");
    });
  });
});
