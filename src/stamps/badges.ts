/**
 * SVG stamp badges with distinct glyphs per tier (color-blind safe)
 * Inline SVG, no external images or fonts
 */

import { StampTier } from "./types";

export interface BadgeSpec {
  /** Icon identifier — key into STAMP_ICON_PATHS */
  icon: StampIcon;
  color: string;
  label: string;
}

/** Geometric monoline icon ids (shape-distinct, color-blind safe) */
export type StampIcon =
  | "check"
  | "exclaim"
  | "cross"
  | "hook"
  | "prohibit"
  | "question";

/**
 * Stroke paths drawn in a 20x20 viewBox. Monoline (uniform stroke width),
 * round caps — renders crisp at 12-16px. No emoji, no font dependency.
 */
const STAMP_ICON_PATHS: Record<StampIcon, Array<string>> = {
  check: ["M5.5 10.5 L9 14 L14.5 6.5"],
  exclaim: ["M10 5 V11.5", "M10 15.4 .01 0"],
  cross: ["M6.5 6.5 L13.5 13.5", "M13.5 6.5 L6.5 13.5"],
  hook: ["M13 3.5 V11.5 A3.5 3.5 0 0 1 6 11.5", "M11.2 5.2 L13 3.5 L14.8 5.2"],
  prohibit: ["M6.5 13.5 L13.5 6.5"],
  question: ["M7.5 7.5 A2.5 2.5 0 1 1 10.9 9.8 C10.2 10.2 10 10.7 10 11.5", "M10 15.4 .01 0"],
};

/** Circle outlines (drawn as stroked circles, not paths) */
const STAMP_ICON_CIRCLES: Partial<Record<StampIcon, Array<[number, number, number]>>> = {
  prohibit: [[10, 10, 6.4]],
};

export const BADGE_SPECS: Record<StampTier, BadgeSpec> = {
  [StampTier.LEGITIMATE]: { icon: "check", color: "#14803c", label: "Legitimate" },
  [StampTier.EXAGGERATED]: {
    icon: "exclaim",
    color: "#8a5a00",
    label: "Exaggerated",
  },
  [StampTier.MISLEADING]: { icon: "cross", color: "#c42b1c", label: "Misleading" },
  [StampTier.CLICKBAIT]: { icon: "hook", color: "#a16207", label: "Clickbait" },
  [StampTier.FAKE]: { icon: "prohibit", color: "#b52f3a", label: "Fake" },
  [StampTier.UNSURE]: { icon: "question", color: "#5c6a7a", label: "Unsure" },
};

/**
 * Build inline SVG badge element for a stamp tier
 */
export function buildBadge(tier: StampTier, explanation: string): SVGElement {
  const spec = BADGE_SPECS[tier];

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.classList.add("nobait-stamp-badge");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${spec.label}: ${explanation}`);

  const circle = document.createElementNS(svgNS, "circle");
  circle.setAttribute("cx", "10");
  circle.setAttribute("cy", "10");
  circle.setAttribute("r", "9");
  circle.setAttribute("fill", spec.color);
  svg.appendChild(circle);

  // Monoline stroke icon — uniform weight, round caps, crisp at small sizes
  const ICON_STROKE_ATTRS: Record<string, string> = {
    stroke: "#ffffff",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    fill: "none",
  };
  for (const d of STAMP_ICON_PATHS[spec.icon]) {
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", d);
    for (const [k, v] of Object.entries(ICON_STROKE_ATTRS)) {
      path.setAttribute(k, v);
    }
    svg.appendChild(path);
  }
  for (const [cx, cy, r] of STAMP_ICON_CIRCLES[spec.icon] ?? []) {
    const outline = document.createElementNS(svgNS, "circle");
    outline.setAttribute("cx", String(cx));
    outline.setAttribute("cy", String(cy));
    outline.setAttribute("r", String(r));
    for (const [k, v] of Object.entries(ICON_STROKE_ATTRS)) {
      outline.setAttribute(k, v);
    }
    svg.appendChild(outline);
  }

  return svg;
}
