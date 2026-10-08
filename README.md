<div align="center">

# nobait

**Better YouTube titles and thumbnails — powered by AI, not crowdsourcing.**

No more ALL CAPS, shocking faces, red arrows, and "you won't believe what happened next."

**Primary platform: Firefox.** Chrome/Chromium support is included if the code stays portable.

</div>

---

## What is this?

nobait is a free and open source browser extension inspired by
[DeArrow](https://dearrow.ajay.app). Where DeArrow relies on crowdsourced human
submissions, nobait uses freely available AI to generate accurate, non-sensational
titles on the fly — and replaces clickbait thumbnails with an actual frame from
the video.

Everything runs client-side in your browser. No accounts, no telemetry, no
central database.

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
4. Rewritten titles are cached and applied everywhere the video appears.

### Thumbnails

Instead of AI-generated images, nobait swaps clickbait thumbnails for **real
frames from the video**, pulled from YouTube's own storyboard sprite sheets
(the same low-res previews YouTube generates for the seek bar). This works
identically in Firefox and Chrome:

- **Frame selection is configurable**: pick from beginning/middle/end, a random
  (deterministically seeded, so it's stable) frame, or a percentage position.
- **Storyboard level** is configurable: higher levels mean larger sprite tiles
  and sharper thumbnails, at slightly more bandwidth.
- Frames are composited locally on a canvas — nothing leaves your browser.

Storyboards are fetched with the same credentials-free requests your browser
already makes to `i.ytimg.com`, so thumbnail replacement costs no API quota and
adds only tens of kilobytes per video.

## AI backends

nobait is backend-agnostic with a pluggable provider interface. The design
goals for backends are: **free, fast, private**.

| Backend | Status | Notes |
|---|---|---|
| Local server (Ollama / llamafile / any OpenAI-compatible endpoint) | Planned default | Full control, works offline, zero cost, perfectly private — and works identically in Firefox and Chrome. |
| Google AI Studio (Gemini API free tier) | Planned | Bring-your-own key; generous free tier, fast flash-class models. Likely the easiest zero-setup option for most users. |
| Custom OpenAI-compatible endpoint | Planned | Any provider you like, self-hosted or otherwise. |
| Chrome built-in AI (Gemini Nano via Prompt API) | Planned bonus | On-device and fully offline, but Chromium-only — offered as an extra backend when running in a browser that supports it. |

An aggressive cache combined with small prompts (titles are short!) keeps
backend usage minimal. Cached entries expire after a configurable TTL so
re-visits stay fresh without repeated calls.

## Platform support

nobait is developed **Firefox-first** — it's a WebExtension built with
cross-browser APIs, packaged for Firefox (AMO) as the primary target, and for
Chrome/Chromium where supporting it doesn't add meaningful complexity.
On-device AI via Chrome's built-in Prompt API is the one Chromium-only extra,
offered behind feature detection; everything else works the same everywhere.

## Privacy

- Title/transcript signal data is sent **only** to the AI backend you
  configure, and only on a cache miss.
- The default on-device backend never sends anything anywhere.
- No analytics, no remote code, no accounts. Ever.

## Roadmap

- [ ] Core: YouTube SPA-aware content script (MutationObserver + navigation events)
- [ ] Title rewriting across all surfaces (home, search, sidebar, shorts shelf, embeds)
- [ ] Signal collection: description, chapters, transcript
- [ ] Cache layer (IndexedDB, per-video TTL)
- [ ] On-device AI backend (Chrome built-in Prompt API)
- [ ] BYO-key Gemini backend
- [ ] Local/OpenAI-compatible backend
- [ ] Thumbnail replacement from storyboards with frame-selection settings
- [ ] Options page: backend picker, tone/style sliders, cache controls, per-channel allowlist
- [ ] Finalize WebExtensions API compatibility (Firefox-first, Chrome-compatible)

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
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the [LICENSE](LICENSE) for details.

## Acknowledgments

- [DeArrow](https://dearrow.ajay.app) by ajayyy — the inspiration for this
  project, and proof that calmer YouTube is possible.
