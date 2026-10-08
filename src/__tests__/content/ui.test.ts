import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetMotionCacheForTests,
  classifyTiming,
  loopStats,
} from "../../content/engine";
import {
  TIMING,
  animateStampPop,
  animateTitleDecode,
  springCurve,
} from "../../content/ui";
import { advanceFrames } from "../setup";

function makeMotionMedia(reduced: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];
  const mql = {
    matches: reduced,
    addEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.push(cb),
    removeEventListener: () => {},
  };
  window.matchMedia = vi.fn().mockReturnValue(mql);
  return { mql, listeners };
}

beforeEach(() => {
  _resetMotionCacheForTests();
});

describe("classifyTiming (adaptive durations)", () => {
  it("classifies cache hits and sub-150ms results as quick", () => {
    makeMotionMedia(false);
    expect(classifyTiming({ inferenceMs: 12, cached: true })).toBe("quick");
    expect(classifyTiming({ inferenceMs: 140 })).toBe("quick");
    expect(classifyTiming({ inferenceMs: 149 })).toBe("quick");
  });

  it("classifies slow inference as full", () => {
    makeMotionMedia(false);
    expect(classifyTiming({ inferenceMs: 150 })).toBe("full");
    expect(classifyTiming({ inferenceMs: 900 })).toBe("full");
  });

  it("forces instant under prefers-reduced-motion regardless of speed", () => {
    makeMotionMedia(true);
    expect(classifyTiming({ inferenceMs: 900 })).toBe("instant");
    expect(classifyTiming({ inferenceMs: 10, cached: true })).toBe("instant");
  });

  it("uses documented budget numbers", () => {
    expect(TIMING.decode).toEqual({ full: 200, quick: 120 });
    expect(TIMING.dissolve).toEqual({ full: 450, quick: 180 });
    expect(TIMING.pop).toEqual({ full: 180, quick: 120 });
    expect(TIMING.fastThresholdMs).toBe(150);
  });
});

describe("animateTitleDecode", () => {
  it("commits the final text instantly in instant mode", () => {
    makeMotionMedia(true);
    const el = document.createElement("span");
    document.body.appendChild(el);
    el.textContent = "You WON'T BELIEVE this!!";
    const onDone = vi.fn();
    const mode = animateTitleDecode(el, "A calm, factual title", {
      videoId: "v1",
      timing: { inferenceMs: 50, cached: true },
      onDone,
    });
    expect(mode).toBe("instant");
    expect(el.textContent).toBe("A calm, factual title");
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("starts scrambled and resolves left-to-right over the budget", () => {
    makeMotionMedia(false);
    const el = document.createElement("span");
    document.body.appendChild(el);
    const NEW = "The quick brown fox jumps";
    animateTitleDecode(el, NEW, {
      videoId: "v2",
      timing: { inferenceMs: 500 },
    });
    // First frame: mostly glyphs, prefix possibly resolved.
    advanceFrames(1);
    const mid = el.textContent ?? "";
    expect(mid).not.toBe("");
    // Advancing well past the 200ms budget settles the final text.
    advanceFrames(20); // ~333ms
    expect(el.textContent).toBe(NEW);
  });

  it("never leaves glyph residue once complete", () => {
    makeMotionMedia(false);
    const el = document.createElement("span");
    document.body.appendChild(el);
    const NEW = "Resolved title here";
    animateTitleDecode(el, NEW, {
      videoId: "v3",
      timing: { inferenceMs: 800 },
    });
    advanceFrames(30); // ~500ms
    expect(el.textContent).toBe(NEW);
  });

  it("preserves spaces as spaces during scramble", () => {
    makeMotionMedia(false);
    const el = document.createElement("span");
    document.body.appendChild(el);
    animateTitleDecode(el, "four word title", {
      videoId: "v4",
      timing: { inferenceMs: 600 },
    });
    advanceFrames(2);
    // Partially resolved: spaces that landed so far are real spaces,
    // unresolved positions hold glyphs. The count must be within bounds
    // and grow toward 3 as more characters settle.
    const spaces = (el.textContent ?? "")
      .split("")
      .filter((c) => c === " ").length;
    expect(spaces).toBeLessThanOrEqual(3);
    expect(spaces).toBeGreaterThan(0);
    advanceFrames(20);
    expect(el.textContent).toBe("four word title");
  });
});

describe("animateStampPop", () => {
  it("lands at scale(1) with opacity 1 when done", () => {
    makeMotionMedia(false);
    const el = document.createElement("div");
    document.body.appendChild(el);
    animateStampPop(el, { videoId: "s1", timing: { inferenceMs: 400 } });
    advanceFrames(1);
    expect(el.style.transform).toMatch(/scale\(/);
    advanceFrames(20); // > 180ms
    expect(el.style.transform).toBe("scale(1)");
    expect(el.style.opacity).toBe("1");
  });

  it("starts small and overshoots past 1.0 mid-flight", () => {
    makeMotionMedia(false);
    const el = document.createElement("div");
    document.body.appendChild(el);
    animateStampPop(el, { videoId: "s2", timing: { inferenceMs: 400 } });
    advanceFrames(1);
    const first = parseFloat(
      el.style.transform.replace("scale(", "").replace(")", ""),
    );
    expect(first).toBeLessThan(1);

    // Sample the curve directly: springCurve must overshoot.
    let peak = 0;
    for (let u = 0; u <= 1; u += 0.05) peak = Math.max(peak, springCurve(u));
    expect(peak).toBeGreaterThan(1.0);
    expect(springCurve(0)).toBeCloseTo(0.6, 2);
    expect(springCurve(1)).toBeCloseTo(1.0, 2);
  });

  it("is instant under reduced motion", () => {
    makeMotionMedia(true);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const onDone = vi.fn();
    animateStampPop(el, {
      videoId: "s3",
      timing: { inferenceMs: 900 },
      onDone,
    });
    expect(el.style.transform).toBe("");
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("adds a shimmer sweep class that is removed when the pop settles", () => {
    makeMotionMedia(false);
    const el = document.createElement("div");
    document.body.appendChild(el);
    animateStampPop(el, { videoId: "s4", timing: { inferenceMs: 400 } });
    expect(el.className).toContain("nobait-stamp-shimmer");
    // Shimmer duration tracks the adaptive pop budget (full = 180ms).
    expect(el.style.getPropertyValue("--nobait-shimmer-ms")).toBe("180ms");
    advanceFrames(20); // > 180ms
    expect(el.className).not.toContain("nobait-stamp-shimmer");
    // Stylesheet is injected exactly once per document.
    const sheets = document.querySelectorAll("#nobait-shimmer-styles");
    expect(sheets.length).toBe(1);
  });

  it("compresses the shimmer with the quick pop budget", () => {
    makeMotionMedia(false);
    const el = document.createElement("div");
    document.body.appendChild(el);
    animateStampPop(el, {
      videoId: "s5",
      timing: { inferenceMs: 40, cached: true },
    });
    expect(el.style.getPropertyValue("--nobait-shimmer-ms")).toBe("120ms");
    advanceFrames(20);
    expect(el.className).not.toContain("nobait-stamp-shimmer");
  });

  it("never attaches the shimmer in instant mode", () => {
    makeMotionMedia(true);
    const el = document.createElement("div");
    document.body.appendChild(el);
    animateStampPop(el, { videoId: "s6", timing: { inferenceMs: 900 } });
    expect(el.className).not.toContain("nobait-stamp-shimmer");
  });
});

describe("shared loop hygiene", () => {
  it("drains and stops when animations finish", () => {
    makeMotionMedia(false);
    const el = document.createElement("span");
    document.body.appendChild(el);
    animateTitleDecode(el, "done soon", {
      videoId: "h2",
      timing: { inferenceMs: 500 },
    });
    advanceFrames(1);
    // May include the current test's decode plus leftovers draining.
    expect(loopStats().activeAnims).toBeGreaterThanOrEqual(1);
    advanceFrames(30);
    expect(loopStats().activeAnims).toBe(0);
  });
});
