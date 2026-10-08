import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetMotionCacheForTests,
  loopStats,
  perfMark,
  schedule,
} from "../../content/engine";
import { animateStampPop, animateTitleDecode } from "../../content/ui";
import { advanceFrames } from "../setup";

function makeMotionMedia(reduced: boolean) {
  const mql = {
    matches: reduced,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  window.matchMedia = vi.fn().mockReturnValue(mql);
}

beforeEach(() => {
  _resetMotionCacheForTests();
});

describe("performance model (acceptance: no jank at scale)", () => {
  it("60 simultaneous title decodes + stamp pops share one loop and complete", () => {
    makeMotionMedia(false);
    const spans: HTMLElement[] = [];
    const stamps: HTMLElement[] = [];
    for (let i = 0; i < 60; i++) {
      const span = document.createElement("span");
      document.body.appendChild(span);
      const stamp = document.createElement("div");
      document.body.appendChild(stamp);
      spans.push(span);
      stamps.push(stamp);
      animateTitleDecode(span, `honest title number ${i}`, {
        videoId: `scale-${i}`,
        timing: { inferenceMs: 500 },
      });
      animateStampPop(stamp, {
        videoId: `scale-${i}`,
        timing: { inferenceMs: 500 },
      });
    }
    // All registered but the loop is ONE shared rAF callback chain.
    advanceFrames(1);
    expect(loopStats().activeAnims).toBe(120); // 60 decodes + 60 pops

    // All finish within their budgets (decode 200ms ≈ 12 frames,
    // pop 180ms ≈ 11 frames; 30 frames ≈ 500ms covers both).
    advanceFrames(30);
    expect(loopStats().activeAnims).toBe(0);
    for (const el of spans) {
      expect(el.textContent).toMatch(/honest title number \d+/);
    }
    for (const el of stamps) {
      expect(el.style.transform).toBe("scale(1)");
    }
  });

  it("animation callbacks that throw do not corrupt the shared loop", () => {
    makeMotionMedia(false);
    const el = document.createElement("span");
    document.body.appendChild(el);

    // Inject a deliberately broken animation via the engine's schedule().
    schedule("broken-1", "broken", () => {
      throw new Error("boom");
    });
    schedule("healthy-1", "decode", () => {
      el.textContent = "still alive";
      return false;
    });

    advanceFrames(2); // must not throw out of the test
    expect(el.textContent).toBe("still alive");
    expect(loopStats().activeAnims).toBe(0);
  });

  it("emits performance marks at each stage (instrumentation)", () => {
    makeMotionMedia(false);
    const el = document.createElement("span");
    document.body.appendChild(el);
    animateTitleDecode(el, "marked", {
      videoId: "mark-1",
      timing: { inferenceMs: 500 },
    });
    advanceFrames(1);
    const names = performance.getEntriesByType("mark").map((m) => m.name);
    expect(names).toContain("nobait:decode:start");
    advanceFrames(20);
    const namesAfter = performance.getEntriesByType("mark").map((m) => m.name);
    expect(namesAfter).toContain("nobait:decode:end");
    // perfMark itself is importable and safe
    expect(() => perfMark("anything")).not.toThrow();
  });
});
