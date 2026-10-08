/**
 * Demo driver for the P5 animation effects (demo/index.html).
 * Generates a synthetic video grid with generated gradient thumbs,
 * then runs the three effects with configurable latency classes.
 */
import {
  animateStampPop,
  animateTitleDecode,
  animatePixelDissolve,
} from "../src/content/ui";
import { reduceMotion, _resetMotionCacheForTests } from "../src/content/engine";

const grid = document.getElementById("grid")!;

const TITLES: Array<[string, string, string]> = [
  [
    "You WON'T BELIEVE what happens next!!!",
    "Presenter reviews a new gadget for 12 minutes",
    "clickbait",
  ],
  [
    "This ONE trick DESTROYS doctors",
    "Study finds modest dietary effect on sleep quality",
    "misleading",
  ],
  [
    "Building a compiler in 30 days",
    "Building a compiler in 30 days",
    "legitimate",
  ],
  [
    "SHOCKING truth about aliens??",
    "Speculative segment on radio anomalies, no new evidence",
    "exaggerated",
  ],
  [
    "10 secrets airlines hide from you",
    "Airline pricing policies explained",
    "exaggerated",
  ],
  [
    "Is water actually POISON?",
    "No. Standard hydration guidance applies.",
    "misleading",
  ],
  [
    "I coded for 24 hours straight (gone wrong)",
    "Developer livestream highlights montage",
    "clickbait",
  ],
  [
    "Quantum computers explained simply",
    "Clear primer on qubits and superposition",
    "legitimate",
  ],
  [
    "The diet doctors refuse to tell you",
    "Common nutrition advice recap, editorialized framing",
    "exaggerated",
  ],
  [
    "Flat earth PROVEN by this experiment",
    "Experiment replication failed; claims debunked",
    "fake",
  ],
  [
    "Blind-tested $20 vs $2000 guitar cables",
    "Listeners could not reliably tell them apart",
    "legitimate",
  ],
  [
    "CITY SINKS INTO THE OCEAN!!",
    "Time-lapse art project of a sand castle city",
    "misleading",
  ],
];

const STAMPS = [
  "legitimate",
  "exaggerated",
  "misleading",
  "clickbait",
  "fake",
  "unsure",
] as const;
const GLYPH_RUN = "✓⚠✗🎣☠?";

// Deterministic decorative gradient thumbnails via inline SVG data URIs.
function makeThumb(i: number): string {
  const hue = (i * 47) % 360;
  const hue2 = (hue + 80) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},65%,45%)"/>
      <stop offset="1" stop-color="hsl(${hue2},65%,30%)"/>
    </linearGradient></defs>
    <rect width="480" height="270" fill="url(#g)"/>
    <circle cx="${60 + ((i * 73) % 360)}" cy="${80 + ((i * 41) % 130)}" r="50" fill="rgba(255,255,255,.25)"/>
    <rect x="${(i * 97) % 380}" y="${(i * 53) % 200}" width="70" height="45" fill="rgba(0,0,0,.35)"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function makeThumbAlt(i: number): string {
  const hue = (i * 47 + 180) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270">
    <rect width="480" height="270" fill="hsl(${hue},70%,35%)"/>
    <rect x="0" y="230" width="480" height="40" fill="rgba(0,0,0,.5)"/>
    <polygon points="210,110 270,140 210,170" fill="rgba(255,255,255,.8)"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function buildGrid(): void {
  grid.innerHTML = "";
  TITLES.forEach(([clickbait, , tier], i) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="thumb"><img alt="" /></div>
      <div class="meta">
        <div class="title"></div>
        <span class="stamp ${tier}">${GLYPH_RUN[Math.min(i, 5)]}</span>
      </div>`;
    const img = card.querySelector("img") as HTMLImageElement;
    img.src = makeThumb(i);
    const titleEl = card.querySelector(".title") as Element;
    titleEl.textContent = clickbait;
    const stampEl = card.querySelector(".stamp") as HTMLElement;
    stampEl.style.display = "none";
    grid.appendChild(card);
    (card as HTMLElement & { dataset: Record<string, string> }).dataset.idx =
      String(i);
  });
}

buildGrid();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).run = function run(
  _cached: boolean,
  inferenceMs: number,
  quickOnly = false,
) {
  const cards = [...grid.children];
  cards.forEach((cardEl, i) => {
    const card = cardEl as HTMLElement;
    const idx = Number(card.dataset.idx);
    const [, honest, tier] = TITLES[idx]!;
    const titleEl = card.querySelector(".title") as Element;
    const img = card.querySelector("img") as HTMLImageElement;
    const stampEl = card.querySelector(".stamp") as HTMLElement;

    const timing = quickOnly
      ? { inferenceMs: 5, cached: true }
      : { inferenceMs, cached: _cached };
    const delay = (i % 6) * 90; // stagger arrivals like streaming results
    setTimeout(() => {
      stampEl.style.display = "";
      animateStampPop(stampEl, { videoId: `demo-${idx}`, timing });
      animateTitleDecode(titleEl, honest, { videoId: `demo-${idx}`, timing });
      void animatePixelDissolve(img, makeThumbAlt(idx), {
        videoId: `demo-${idx}`,
        timing,
      });
      void tier;
      void STAMPS;
    }, delay);
  });
};

let forceReduced = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).toggleReduced = function toggleReduced() {
  forceReduced = !forceReduced;
  const real = window.matchMedia("(prefers-reduced-motion: reduce)");
  // Demonstrate the collapse: monkey-patch matchMedia for the demo session.
  const original = window.matchMedia.bind(window);
  window.matchMedia = ((q: string) =>
    q.includes("prefers-reduced-motion")
      ? { ...real, matches: forceReduced }
      : original(q)) as typeof window.matchMedia;
  _resetMotionCacheForTests();
  const reduced = reduceMotion();
  console.log("[nobait demo] reduced-motion now:", reduced);
};
