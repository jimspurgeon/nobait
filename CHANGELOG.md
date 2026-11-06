# Changelog

All notable changes to nobait are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — initial 0.1.0 milestone (six implementation phases)

#### P1 — Project skeleton

- Firefox-first WebExtension scaffold (MV3, esbuild pipeline, IIFE bundles)
- Content script with SPA navigation detection (`yt-navigate-finish`,
  Navigation API, conservative polling fallback)
- Centralized YouTube selector registry (`src/content/dom.ts`)
- Credibility stamp system types: six-tier closed enum (✓ legitimate,
  ⚠ exaggerated, ✗ misleading, 🎣 clickbait, ☠️ fake, ? unsure)
- Unit test scaffolding (Vitest + jsdom) and E2E scaffolding (Playwright)

#### P2 — Thumbnail replacement

- Storyboard spec parsing from `player_response` / `ytcfg`
- Deterministic frame-position math (start/middle/end/random, seeded by
  video ID + config for cross-session consistency)
- Canvas tile cropper producing composited replacement thumbnails
- Hardcoded InnerTube key removed in favor of runtime `ytcfg` extraction

#### P3 — Cache + Gemini

- IndexedDB analysis cache with TTL (7-day positive, 24-hour negative)
  and model-version invalidation
- Negative cache preventing repeated AI calls on unanalyzable videos
- Batch structured prompts (up to 20 videos per request) via
  `GeminiProvider.analyzeBatch()` on `gemini-2.5-flash-lite`
- Incremental streaming result parser patching DOM as each video result
  completes
- Request coalescing (50 ms window) and video-ID deduplication
- Options UI for API key management (`browser.storage.local`)

#### P4 — Pluggable AI providers

- Canonical `AIProvider` interface shared by all backends
- Ollama / OpenAI-compatible local server provider
- Chrome built-in AI (Nano / Prompt API) provider, feature-gated
- Provider factory with selection order: Chrome built-in AI → Gemini →
  Ollama → disabled-with-warning

#### P5 — Animations

- Title decode scramble effect (200 ms full / 120 ms quick / 0 ms
  reduced motion)
- Thumbnail pixel-grid dissolve (450 ms / 180 ms / 0 ms)
- Stamp pop-in spring with diagonal shimmer sweep (180 ms / 120 ms / 0 ms)
- Adaptive timing classification based on reported inference latency
  (fast threshold: 150 ms); reduced-motion users always get instant swaps

#### P6 — Fact-check layer

- ClaimReview search client for FAKE-tier corroboration
- Trigger heuristic detecting factual claims in titles/descriptions
- Racing 400 ms lookup timeout — fact-check results never delay UI
- Corroboration flow upgrading suspected-fake classifications with
  external evidence

### Fixed

- Restored `node_modules/` and `dist/` to `.gitignore` and untracked them
  from the repository
- RATING_CLUSTERS regex handling of leading whitespace (broke
  corroboration matching)
- Bound background `fetch` to `globalThis` for service-worker context
- Reconciled P2/P3 code with strict `tsconfig` flags

[Unreleased]: https://github.com/jimspurgeon/nobait/compare/master...HEAD
