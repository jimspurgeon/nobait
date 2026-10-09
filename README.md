<div align="center">

# nobait

**Better YouTube titles and thumbnails — powered by AI, not crowdsourcing.**

No more ALL CAPS, shocking faces, red arrows, and "you won't believe what happened next.",
plus instant visual stamps showing whether a video is legitimate, exaggerated, or outright false.

**Primary platform: Firefox.** Chrome/Chromium support is included if the code stays portable.

</div>

---

## What is this?

nobait is a free and open source browser extension inspired by
[DeArrow](https://dearrow.ajay.app). Where DeArrow relies on crowdsourced human
submissions, nobait uses freely available AI to generate accurate, non-sensational
titles on the fly, swap clickbait thumbnails with actual video frames, and affix
a visual **credibility stamp** that instantly tells you if the video is
legitimate, exaggerated-but-true, or completely misleading.

Everything runs client-side in your browser. No accounts, no telemetry, no
central database.

## Installation

### From source (temporary add-on in Firefox)

1. Clone and build:

   ```bash
   npm install
   npm run build:firefox
   ```

2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…** and select `dist/firefox/manifest.json`.
4. Visit YouTube. Done — the temporary add-on stays loaded until Firefox
   restarts.

> A signed `.xpi` for AMO (addons.mozilla.org) will accompany the first
> tagged release. Chrome builds (`npm run build:chrome`) are not yet wired
> up (see Roadmap).

## Zero-config AI setup

nobait tries to find a working AI backend **automatically on first run**:

1. **Ollama autodetect** — if a local [Ollama](https://ollama.com) server is
   running on `http://localhost:11434`, nobait detects it, picks the best
   installed model (preferring small, fast ones like `qwen3:0.6b`), and
   uses it for title rewriting and credibility stamps. Nothing leaves your
   machine.
2. **Gemini key wizard** — if no local server is found, the options page
   shows a setup banner linking to [Google AI Studio](https://aistudio.google.com/apikey)
   where you can create a **free** API key. Paste it into Settings → AI
   Backend → Gemini; nobait validates it live before saving.

Until one of these is configured, nobait still fully works for
**thumbnail replacement** (real video frames via YouTube's public
storyboard endpoints) — only title rewriting and stamps wait for a backend.

**Tip for Ollama users**: if autodetect finds the server but evaluations
fail with a network error, open the extension's Settings and enter
`http://localhost:11434` + your model tag manually — this pins the provider
so Firefox's host permission approval sticks.

## Development

```bash
npm install          # install dev dependencies
npm run dev:firefox  # rebuild on change (no hot reload inside the browser)
npm test             # Vitest unit tests (jsdom)
npm run typecheck    # tsc --noEmit (strict)
npm run lint         # ESLint + Prettier check
npm run lint:fix     # ESLint + Prettier auto-fix
npm run build:firefox # production bundle into dist/firefox/
```

Debugging: load the built add-on via `about:debugging` (above), open the
background console from the "Inspect" link, and filter on `[nobait]`. On any
YouTube page, `window.dispatchEvent(new CustomEvent('nobait:debug'))` dumps
diagnostics to the console. See [AGENTS.md](AGENTS.md) for conventions.

## How it works

### Titles

1. When a video appears on YouTube (home feed, search results, sidebar, watch
   page), the content script collects its **signal data**: original title,
   description, chapter markers, and (when available) the video's transcript.
2. A local **cache** (IndexedDB, keyed by video ID + a hash of the input
   signals) is checked first — most videos never trigger an AI call at all.
3. On a cache miss, the configured **AI backend** rewrites the title to be
   factual and descriptive: no hype, no withholding ("...and you won't believe
   #3"), no ALL CAPS, no manufactured curiosity gaps.
4. Rewritten titles are cached and applied everywhere the video appears,
   animated with a terminal-style character "decode" that adapts to how fast
   the result arrived.

### Thumbnails

Instead of AI-generated images, nobait swaps clickbait thumbnails for **real
frames from the video**, pulled from YouTube's own storyboard sprite sheets
(the same low-res previews YouTube generates for the seek bar):

- **Frame selection is configurable** in options: start / middle / end, a
  deterministic-seeded random frame, or an exact percentage position.
- Frames are composited locally on a canvas — nothing leaves your browser.
- The swap plays a pixel-grid dissolve (respecting `prefers-reduced-motion`).

Storyboards are fetched with the same credentials-free requests your browser
already makes to `i.ytimg.com`, so thumbnail replacement costs no API quota
and adds only tens of kilobytes per video.

### Credibility stamps

After analyzing the video's title, description, and transcript, nobait
assigns an **unambiguous credibility stamp** that appears next to the title
on home feed, search results, and the watch page:

| Stamp           | Glyph | Color    | Meaning                                                                |
| --------------- | ----- | -------- | ---------------------------------------------------------------------- |
| **Legitimate**  | ✓     | Green    | Accurate title, honest premise, content matches claims                 |
| **Exaggerated** | ⚠     | Amber    | Claims are true but overstated, sensationalized framing                |
| **Misleading**  | ✗     | Red      | Title implies something false, content contradicts premise             |
| **Clickbait**   | 🎣    | Orange   | Withholding info, manufactured curiosity gap, "you won't believe" style |
| **Fake**        | ☠️    | Dark red | Completely fabricated premise, hoaxes, debunked claims                 |
| **Unsure**      | ?     | Gray     | Insufficient data for confidence (no transcript, too short)           |

Glyphs are shape-distinct (never color-only) and colors meet WCAG AA contrast
against YouTube's light and dark themes. Hovering a stamp shows the one-two
sentence explanation from the classifier.

An optional **fact-check layer** races Google Fact Check Tools (ClaimReview)
lookups in parallel with inference (400 ms hard timeout) and can strengthen a
FAKE-leaning rating with corroborating sources. It is opt-in and requires
your own API key.

## AI backends

nobait is backend-agnostic with a pluggable provider interface. The design
goals for backends are: **free, fast, private**.

| Backend                                                            | Status | Notes                                                                                                                                    |
| ------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Local server (Ollama / llamafile / any OpenAI-compatible endpoint) | Built  | Full control, works offline, zero cost, perfectly private — and works identically in Firefox and Chrome. Also performs credibility classification. |
| Google AI Studio (Gemini API free tier)                            | Built  | Bring-your-own key; generous free tier, fast flash-class models. Likely the easiest zero-setup option for most users.                    |
| Chrome built-in AI (Gemini Nano via Prompt API)                    | Built  | On-device and fully offline, but Chromium-only — offered as an extra backend when running in a browser that supports it.                   |

The backend is selected in the options page: **Auto** follows the priority
chain (Chrome built-in AI → Gemini → Ollama → disabled), or you can pin a
specific provider. A single AI prompt handles both **title rewriting** and
**credibility classification**, keeping token usage efficient. The same
aggressive cache applies to stamps, so revisits stay snappy.

## Architecture

```text
src/
├── manifest.json        # Firefox MV3 manifest (canonical)
├── background/          # Service worker: message router, scheduler, fact-check
│   └── ...
├── content/             # Runs on youtube.com
│   ├── index.ts         # Bootstrap: stamps pipeline + thumbnail swaps
│   ├── observer.ts      # MutationObserver + IntersectionObserver (rAF-batched)
│   ├── dom.ts           # All YouTube selectors live here
│   ├── ui.ts            # Animation engine (decode/dissolve/pop-in, reduced-motion aware)
│   ├── engine.ts        # Adaptive animation timing classification
│   └── thumb-swapper.ts # Thumbnail injection with batched crossfades
├── ai/                  # Providers behind a common interface
│   ├── factory.ts       # Selection + fallback chain
│   ├── gemini.ts        # Google AI Studio (BYO key)
│   ├── ollama.ts        # Local OpenAI-compatible endpoint
│   ├── nano.ts          # Chrome built-in Prompt API
│   └── classify.ts      # Strict 6-tier parsing (fallback: UNSURE)
├── stamps/              # Tier types, SVG badges, hover tooltips
├── thumbnail/           # Storyboard parsing, frame math, canvas rendering
├── storage/             # IndexedDB cache layers
├── settings/            # Unified typed settings + storage.onChanged wiring
├── options/             # Options page (HTML/CSS/TS)
└── utils/               # url, idb, message helpers
```

Key flows:

- **Content script ⇄ background**: tiny JSON messages
  (`EVALUATE_VIDEO`, `CLEAR_CACHE`, …). The background worker owns all
  network, inference, and caching; the content script only observes and
  patches the DOM.
- **Settings**: one typed object in `browser.storage.local`, edited by the
  options page, live-applied in content scripts via `storage.onChanged`
  (no page reload needed).
- **Performance**: look-ahead evaluation via IntersectionObserver (600 px)
  means inference often finishes before a card scrolls into view; batched
  rAF animations keep 60 simultaneous patches at 60 fps.

## Options

Everything is configurable from the options page:

- **AI backend**: Auto / Chrome built-in / Gemini (API key) / Ollama (URL + model).
- **Thumbnails**: frame position (start/middle/end/random/percentage).
- **Stamps**: visibility, placement, per-tier toggles.
- **Animations**: on/off + intensity (subtle/normal/full).
- **Cache**: TTL presets + clear-cache button.
- **Channels**: per-channel allowlist (never touch) and blocklist.
- **Fact-check layer**: enable/disable + API key.

## Privacy

- Title/transcript signal data is sent **only** to the AI backend you
  configure, and only on a cache miss.
- The default on-device/local backend never sends anything anywhere.
- No analytics, no remote code, no accounts. Ever.

## Roadmap

Done (P1–P7): SPA-aware content script, thumbnail replacement from
storyboards, IndexedDB caching, Gemini/Ollama/Chrome-Nano backends with
fallback chain, title rewriting, 6-tier credibility stamps with tooltips,
fact-check corroboration layer, decode/dissolve/pop-in animations
(reduced-motion aware), and the full options page with live-applied settings.

Next up:

- [ ] Signed AMO release (`.xpi`)
- [ ] Chrome build variant (`build:chrome`) and Chromium E2E
- [ ] Playwright E2E suite against real YouTube pages
- [ ] Fact-check tooltip sources display
- [ ] i18n

## Contributing

See [AGENTS.md](AGENTS.md) for development conventions, and feel free to open
issues or pull requests. All contributions are welcome!

## License

Copyright (C) 2026 Jim Spurgeon

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
A PARTICULAR PURPOSE. See the [LICENSE](LICENSE) for details.

## Acknowledgments

- [DeArrow](https://dearrow.ajay.app) by ajayyy — the inspiration for this
  project, and proof that calmer YouTube is possible.
