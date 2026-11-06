/**
 * Keyboard-accessibility tests for stamp tooltips (gatekeeper finding):
 * badges must be focusable and show/hide their tooltip on focus/blur,
 * mirroring mouseenter/mouseleave.
 */

import { describe, it, expect, afterEach } from "vitest";
import { attachTooltip, createTooltip } from "../../stamps/tooltips";

describe("attachTooltip keyboard accessibility", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("makes the host focusable via tabindex", () => {
    const host = document.createElement("span");
    document.body.appendChild(host);
    attachTooltip(host, "explanation");
    expect(host.getAttribute("tabindex")).toBe("0");
  });

  it("preserves an existing tabindex", () => {
    const host = document.createElement("span");
    host.setAttribute("tabindex", "2");
    document.body.appendChild(host);
    attachTooltip(host, "explanation");
    expect(host.getAttribute("tabindex")).toBe("2");
  });

  it("shows the tooltip on focus and hides it on blur", () => {
    const host = document.createElement("span");
    document.body.appendChild(host);
    attachTooltip(host, "kb explanation");

    const tooltip = document.querySelector<HTMLElement>(".nobait-tooltip");
    expect(tooltip).not.toBeNull();
    expect(tooltip!.style.opacity).toBe("0");

    host.dispatchEvent(new FocusEvent("focus"));
    expect(tooltip!.style.opacity).toBe("1");

    host.dispatchEvent(new FocusEvent("blur"));
    expect(tooltip!.style.opacity).toBe("0");
  });

  it("still shows/hides on mouseenter/mouseleave", () => {
    const host = document.createElement("span");
    document.body.appendChild(host);
    attachTooltip(host, "mouse explanation");

    const tooltip = document.querySelector<HTMLElement>(".nobait-tooltip")!;
    host.dispatchEvent(new MouseEvent("mouseenter"));
    expect(tooltip.style.opacity).toBe("1");
    host.dispatchEvent(new MouseEvent("mouseleave"));
    expect(tooltip.style.opacity).toBe("0");
  });

  it("removes focus/blur listeners on cleanup", () => {
    const host = document.createElement("span");
    document.body.appendChild(host);
    attachTooltip(host, "cleanup test");

    const tooltip = document.querySelector<HTMLElement>(".nobait-tooltip")!;
    host._nobaitTooltipCleanup?.();

    host.dispatchEvent(new FocusEvent("focus"));
    expect(tooltip.style.opacity).toBe("0"); // no longer reacting
    expect(tooltip.isConnected).toBe(false); // removed from DOM
  });

  it("tooltip text is set via textContent (no HTML injection)", () => {
    const tooltip = createTooltip('<img src=x onerror="alert(1)">');
    expect(tooltip.textContent).toContain("<img");
    expect(tooltip.querySelector("img")).toBeNull();
  });
});
