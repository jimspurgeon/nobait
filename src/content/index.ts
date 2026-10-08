// nobait content script bootstrap (P5 – animation layer).
// This file wires the animation engine to the YouTube DOM observer.

export type { AnimMode } from "./engine";
export {
  animateTitleDecode,
  animatePixelDissolve,
  animateStampPop,
  applyResult,
  TIMING,
} from "./ui";
export { classifyTiming, reduceMotion } from "./engine";

// NOTE: Actual YouTube DOM selector wiring lives in content/dom.ts
// and observer.ts per the AGENTS.md / PLAN.md architecture.
