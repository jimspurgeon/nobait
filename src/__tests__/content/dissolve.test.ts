import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetMotionCacheForTests } from "../../content/engine";
import { animatePixelDissolve, applyResult } from "../../content/ui";
import { advanceFrames } from "../setup";

function makeMotionMedia(reduced: boolean) {
  const mql = {
    matches: reduced,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  window.matchMedia = vi.fn().mockReturnValue(mql);
}

function makeThumb(): HTMLImageElement {
  const img = document.createElement("img");
  img.src = "blob:old-thumb";
  document.body.appendChild(img);
  return img;
}

beforeEach(() => {
  _resetMotionCacheForTests();
});

describe("animatePixelDissolve", () => {
  it("swaps src instantly with no overlay under reduced motion", async () => {
    makeMotionMedia(true);
    const img = makeThumb();
    const mode = await animatePixelDissolve(img, "blob:new-frame", {
      videoId: "t1",
      timing: { inferenceMs: 900 },
    });
    expect(mode).toBe("instant");
    expect(img.src).toContain("blob:new-frame");
    // No canvas overlay was introduced.
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("places a canvas overlay over the thumbnail and removes it on completion", async () => {
    makeMotionMedia(false);
    const img = makeThumb();
    const onDone = vi.fn();
    const mode = await animatePixelDissolve(img, "blob:new-frame", {
      videoId: "t2",
      timing: { inferenceMs: 600 },
      onDone,
    });
    expect(mode).toBe("full");
    // Underlying image swapped immediately beneath the overlay.
    expect(img.src).toContain("blob:new-frame");

    advanceFrames(1);
    const overlay = document.querySelector("canvas");
    expect(overlay).not.toBeNull();
    expect(img.parentElement!.contains(overlay!)).toBe(true);

    // ~450ms budget → ~28 frames; run past it.
    advanceFrames(35);
    expect(document.querySelector("canvas")).toBeNull();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("compresses to the quick budget (~180ms) on cache hits", async () => {
    makeMotionMedia(false);
    const img = makeThumb();
    const mode = await animatePixelDissolve(img, "blob:cached-frame", {
      videoId: "t3",
      timing: { inferenceMs: 40, cached: true },
    });
    expect(mode).toBe("quick");
    advanceFrames(1);
    expect(document.querySelector("canvas")).not.toBeNull();
    // Quick budget 180ms ≈ 11 frames; overlay gone by frame ~14.
    advanceFrames(14);
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("falls back to a hard swap when the image fails to decode", async () => {
    makeMotionMedia(false);
    const img = makeThumb();
    // Break decode for this specific instance by returning a rejecting promise.
    const badImage = new Image();
    badImage.decode = async () => Promise.reject(new Error("decode fail"));
    vi.spyOn(globalThis, "Image").mockReturnValue(
      badImage as unknown as HTMLImageElement,
    );
    const mode = await animatePixelDissolve(img, "blob:bad", {
      videoId: "t4",
      timing: { inferenceMs: 600 },
    });
    vi.restoreAllMocks();
    expect(mode).toBe("full");
    expect(img.src).toContain("blob:bad");
    expect(document.querySelector("canvas")).toBeNull();
  });
});

describe("applyResult facade", () => {
  it("runs title decode and stamp pop together from one patch", () => {
    makeMotionMedia(false);
    const titleEl = document.createElement("span");
    document.body.appendChild(titleEl);
    const stampEl = document.createElement("div");
    document.body.appendChild(stampEl);

    applyResult(titleEl, {
      videoId: "facade1",
      title: "A perfectly normal title",
      stampEl,
      timing: { inferenceMs: 420 },
    });

    advanceFrames(1);
    // Both effects are live in the shared loop.
    const marks = performance.getEntriesByType("mark");
    expect(marks.some((m) => m.name === "nobait:decode:start")).toBe(true);
    expect(marks.some((m) => m.name === "nobait:pop:start")).toBe(true);
    advanceFrames(30);
    expect(titleEl.textContent).toBe("A perfectly normal title");
  });
});
