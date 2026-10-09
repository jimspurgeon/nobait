/**
 * SVG stamp badges with distinct glyphs per tier (color-blind safe)
 * Inline SVG, no external images or fonts
 */

import { StampTier } from "./types";

export interface BadgeSpec {
  glyph: string;
  color: string;
  label: string;
}

export const BADGE_SPECS: Record<StampTier, BadgeSpec> = {
  [StampTier.LEGITIMATE]: { glyph: "✓", color: "#14803c", label: "Legitimate" },
  [StampTier.EXAGGERATED]: {
    glyph: "!",
    color: "#8a5a00",
    label: "Exaggerated",
  },
  [StampTier.MISLEADING]: { glyph: "✗", color: "#c42b1c", label: "Misleading" },
  [StampTier.CLICKBAIT]: { glyph: "🎣", color: "#a16207", label: "Clickbait" },
  [StampTier.FAKE]: { glyph: "☠", color: "#b52f3a", label: "Fake" },
  [StampTier.UNSURE]: { glyph: "?", color: "#5c6a7a", label: "Unsure" },
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

  const text = document.createElementNS(svgNS, "text");
  text.setAttribute("x", "10");
  text.setAttribute("y", "14.5");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("font-size", "12");
  text.setAttribute("fill", "#ffffff");
  text.setAttribute("font-family", "system-ui, sans-serif");
  if (tier === StampTier.CLICKBAIT || tier === StampTier.FAKE) {
    text.setAttribute("font-weight", "bold");
  }
  text.textContent = spec.glyph;
  svg.appendChild(text);

  return svg;
}
