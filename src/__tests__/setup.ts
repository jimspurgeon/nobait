/**
 * Test setup: jsdom lacks rAF timing realism and canvas 2D
 * rasterization, so we stub the pieces the animation engine needs.
 */

// --- rAF driven by a manually-advanced virtual clock -----------------------
type RafCb = (t: number) => void;
const rafQueue: Array<{ cb: RafCb; id: number }> = [];
let now = 0;
let rafIdSeq = 1;

// Expose the queue so advanceFrames can drain it during tests.
(globalThis as unknown as { _rafQueue: typeof rafQueue })._rafQueue = rafQueue;

globalThis.requestAnimationFrame = ((cb: RafCb) => {
  const id = rafIdSeq++;
  rafQueue.push({ cb, id });
  return id;
}) as unknown as typeof requestAnimationFrame;

globalThis.cancelAnimationFrame = ((id: number) => {
  const idx = rafQueue.findIndex((f) => f.id === id);
  if (idx >= 0) rafQueue.splice(idx, 1);
}) as unknown as typeof cancelAnimationFrame;

/** Advance the virtual clock, firing scheduled rAF callbacks in FIFO order. */
export function advanceFrames(frames: number, dt = 16.67): void {
  for (let f = 0; f < frames; f++) {
    now += dt;
    const batch = rafQueue.splice(0, rafQueue.length);
    for (const item of batch) {
      item.cb(now);
    }
  }
}

// --- Canvas 2D stub ---------------------------------------------------------
// jsdom's getContext returns null; the engine only needs drawImage,
// clearRect, fillRect, getImageData and property setters to be callable.
const noop = () => {};
const ctxStub = {
  drawImage: noop,
  clearRect: noop,
  fillRect: noop,
  getImageData: (_x: number, _y: number, w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4).fill(128),
    width: w,
    height: h,
  }),
  putImageData: noop,
  imageSmoothingEnabled: true,
  fillStyle: "",
  canvas: null,
};

const origCreateElement = document.createElement.bind(document);
document.createElement = ((tag: string, opts?: ElementCreationOptions) => {
  const el = origCreateElement(tag, opts) as HTMLElement & {
    getContext?: (t: string, o?: unknown) => unknown;
    decode?: () => Promise<void>;
  };
  if (tag.toLowerCase() === "canvas") {
    el.getContext = ((type: string) =>
      type === "2d"
        ? { ...ctxStub, canvas: el }
        : null) as HTMLCanvasElement["getContext"];
  }
  if (tag.toLowerCase() === "img" || tag.toLowerCase() === "image") {
    el.decode = async () => {};
  }
  return el as HTMLElement;
}) as typeof document.createElement;

// jsdom Image lacks decode(); give every constructed Image one.
// Patch the prototype (rather than swapping constructors) so BOTH
// `new Image()` and `document.createElement('img')` instances get it,
// regardless of which global binding the module under test captured.
const imgProto = Object.getPrototypeOf(globalThis.Image?.prototype ?? {});
if (imgProto && !("decode" in imgProto)) {
  (imgProto as unknown as { decode: () => Promise<void> }).decode = () =>
    Promise.resolve();
}

// Silence performance.mark if jsdom lacks User Timing entirely.
if (typeof performance.mark !== "function") {
  (performance as unknown as { mark: () => void }).mark = noop;
  (performance as unknown as { measure: () => void }).measure = noop;
}
