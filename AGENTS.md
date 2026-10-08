# nobait — AGENTS.md

This document guides AI coding agents (and human contributors) on how to work on
the nobait project. Think of it as a team member's handbook for getting things
done right.

## TL;DR for agents

- **Platform focus**: Firefox WebExtensions. Chrome/Chromium support only if
  the code stays portable. No Chrome-only APIs unless behind a feature flag
  with a Firefox fallback.
- **Tech stack**: TypeScript, vanilla JS modules, no frameworks. Build via
  Vite or esbuild. Manifest V3 compatible (but test against MV2 where needed).
- **File structure**: Follow the canonical layout below. Never nest logic deep;
  keep modules flat and composable.
- **Testing**: Write unit tests with Vitest, E2E with Playwright (headless
  Firefox + Chrome). CI runs both.
- **Commit style**: Conventional Commits (`feat:`, `fix:`, `chore:`). One
  logical change per commit. Reference issues in commit messages.
- **PR checklist**: All tests green, lint clean, no breaking changes without
  migration notes.

## Project overview

nobait is a browser extension that replaces clickbait YouTube titles with
AI-generated, factual alternatives, swaps thumbnails with actual video frames
from storyboards, and adds unambiguous **credibility stamps** (✓ green
legitimate, ⚠ yellow exaggerated, ✗ red misleading, 🎣 orange clickbait,
☠️ dark-red fake, ? gray unsure) so users can see at a glance whether a video
is worth watching. It is **Firefox-first**; Chrome/Chromium builds are a
secondary target.

Key design principles:

1. **Portability**: Everything must run on Firefox. Chrome support is
   acceptable only when it doesn't complicate the codebase or require
   polyfills that bloat the bundle.
2. **Privacy-first**: No telemetry, no accounts, no remote databases. All
   caching is local (IndexedDB).
3. **Pluggable AI**: Backend implementations are isolated behind a thin
   interface. New providers (on-device, BYO-key, local server) should drop in
   without touching core logic.
4. **SPA awareness**: YouTube is a single-page app. The extension must react
   to navigations and dynamic DOM updates using `Navigation` API or
   `MutationObserver`.

## Directory layout

```text
.nobait/          # (ignored) Local dev artifacts
src/
├── manifest.json     # Firefox MV3 manifest; Chrome variant via transform
├── background/       # Service worker / background script
│   ├── index.ts      # Entry point
│   └── cache.ts      # Cache logic (shared)
├── content/          # Content script (runs on youtube.com)
│   ├── index.ts      # Injection & DOM mutation entry
│   ├── signals.ts    # Title/description/transcript extraction
│   ├── dom.ts        # YouTube-specific DOM selectors & patches
│   └── observer.ts   # Navigation/DOM change watchers
├── ai/               # AI provider implementations
│   ├── types.ts      # Provider interface
│   ├── chromeprompt.ts   # Chrome built-in AI (optional)
│   ├── gemini.ts         # Google AI Studio (BYO key)
│   ├── ollama.ts         # Local Ollama/server endpoint
│   ├── factory.ts        # Provider selection & fallback
│   └── classify.ts       # Credibility classification prompt & parsing
├── stamps/           # Credibility stamp system
│   ├── types.ts      # StampTier enum & interfaces
│   ├── badges.ts     # Badge rendering (SVG icons, colors)
│   └── tooltips.ts   # Hover explanations
├── storage/          # IndexedDB abstraction
│   └── cache.ts
├── thumbnail/        # Frame selection & rendering
│   ├── storyboard.ts # Fetch & parse storyboard specs
│   ├── frame.ts      # Frame position logic
│   └── render.ts     # Canvas composition
├── options/          # Options page (HTML/CSS/TS)
│   ├── index.html
│   ├── styles.css
│   └── index.ts
├── utils/            # Shared helpers
│   ├── dom.ts
│   ├── url.ts
│   └── idb.ts
├── styles/           # Global extension styles
│   └── base.css
├── types/            # Shared TypeScript interfaces
│   └── index.d.ts
└── __tests__/        # Unit tests (Vitest)
    ├── ai/
    ├── stamps/
    ├── thumbnail/
    └── utils/
public/               # Static assets (icons, etc.)
├── icons/
│   ├── 48.png
│   └── 96.png
├── stamp-icons/      # SVG assets for each stamp tier
├── storyboards/      # (optional) test fixtures
└── transcripts/      # (optional) test fixtures
vite.config.ts
tsconfig.json
package.json
AGENTS.md             # This file
LICENSE
```

## Platform notes

### Firefox first

- Use **WebExtensions API** (no Chrome-exclusive APIs).
- Test against Firefox Nightly, Stable, and ESR.
- `manifest.json` targets Firefox. For Chrome, we can generate a variant via
  build-time transforms (e.g., replace `"applications"` block).
- Background scripts use service workers (MV3), with a fallback to persistent
  background if needed for older Firefox versions.

### Chrome support rules

- Only include Chrome-specific code if:
  - It's behind a feature detection gate (`typeof chrome !== 'undefined' &&
    chrome.i18n?.acceptLanguage`),
  - A Firefox-compatible fallback exists,
  - And the complexity gain is minimal (<50 LOC per feature).
- Examples of acceptable Chrome-only features:
  - Chrome built-in AI (Prompt API) as an opt-in backend.
- Reject features that:
  - Require `chrome.*` APIs with no `browser.*` equivalent,
  - Add significant bundle size,
  - Create divergent code paths.

## Build & test commands

### Setup

```bash
npm install
```

### Development

```bash
npm run dev:firefox  # Vite dev mode with Firefox hot reload
npm run dev:chrome   # Chrome variant (if implemented)
```

### Build

```bash
npm run build:firefox
npm run build:chrome  # Optional
```

Output: `dist/firefox/` and `dist/chrome/` directories ready for packaging.

### Test

```bash
npm test              # Vitest unit tests
npm run test:e2e      # Playwright headless Firefox + Chrome
npm run lint          # ESLint + Prettier check
```

### Lint & typecheck

```bash
npm run lint:fix
npm run typecheck
```

## AI provider implementation guide

New providers go in `src/ai/`. Follow this contract:

```typescript
export interface AIProvider {
  readonly name: string;
  readonly supportsStreaming: boolean;

  analyze(input: {
    title: string;
    description?: string;
    transcript?: string;
    chapters?: Array<{ startMs: number; title: string }>;
  }): Promise<{
    rewrittenTitle: string;
    stamp: StampTier;
    stampExplanation: string; // 1-2 sentences: why this rating
  }>;

  close?(): void; // Cleanup on shutdown
}
```

### Credibility stamps

The stamp classification is produced by the same `analyze()` call as title
rewriting — one prompt, one round trip. `StampTier` is a closed enum (never
free-form):

```typescript
// src/stamps/types.ts
export enum StampTier {
  LEGITIMATE = 'legitimate', // ✓ green  — accurate, honest, matches content
  EXAGGERATED = 'exaggerated', // ⚠ yellow — true but overstated/sensationalized
  MISLEADING = 'misleading', // ✗ red    — title implies something false
  CLICKBAIT = 'clickbait',   // 🎣 orange — withholding, manufactured curiosity
  FAKE = 'fake',             // ☠️ dark red — fabricated premise/debunked
  UNSURE = 'unsure',         // ? gray   — insufficient signal data
}
```

Rules for the classification prompt (see `src/ai/classify.ts`):

- The AI must output **exactly one** tier from the enum plus a one-sentence
  explanation. Parse strictly; fall back to `UNSURE` on any ambiguity.
- Ratings must be grounded in evidence from the transcript/description —
  never punish a title merely for being popular.
- The stamp applies to the video's **original framing**, not the rewritten
  title.

Stamp rendering (`src/stamps/badges.ts`):

- Inline SVG icons colored by tier, injected next to titles via
  `src/content/stamps.ts`. No external images, no font dependency.
- Colors must meet WCAG AA contrast against YouTube's light and dark themes.
- Hover tooltip shows `stampExplanation` (pure CSS/JS tooltip, no framework).
- Icons must convey meaning by shape alone (color-blind safe): distinct
  glyphs per tier, never color-only differentiation.

Each implementation must:

- Be isolated in its own module.
- Handle errors gracefully and reject with descriptive `Error` objects.
- Not mutate input data.
- Respect global timeout settings (injected via constructor or config).

Example file structure:

```text
src/ai/
├── types.ts          # Interface definition
├── factory.ts        # Factory returning provider based on config
├── chromeprompt.ts   # Chrome built-in AI (optional)
├── gemini.ts         # Google AI Studio (BYO key)
└── ollama.ts         # Local Ollama / OpenAI-compatible
```

The `factory` selects the provider based on user preferences:

1. If Chrome built-in AI is available → use it (opt-out in options).
2. Else if a Gemini API key is set → use that.
3. Else if an Ollama/local URL is configured → use that.
4. Else → disable title rewriting with a console warning.

## Thumbnail replacement

Thumbnail logic lives in `src/thumbnail/`. YouTube provides storyboard sprite
sheets via URLs like:

```
https://i9.ytimg.com/sb/<VIDEO_ID>/storyboard3_L<N>/<M>.jpg?sigh=<SIG>
```

Implementation steps:

1. Parse `player_response` embedded in YouTube pages to extract storyboard
   spec JSON (available in `storyboards` array).
2. Compute which sprite tile contains the desired frame based on:
   - Configured frame position (start/middle/end/random).
   - Tile count per sprite (`N`).
   - Frames per tile (from spec).
3. Fetch the sprite image (small file, cached).
4. Crop the correct tile on a hidden `<canvas>` and set it as the
   thumbnail's `src`.

All calculations are deterministic given a seed (video ID + config), so the
same frame appears consistently across sessions.

## Content script architecture

YouTube is a dynamic SPA. Key points:

- **Injection strategy**: Manifest declares `matches: "*://*.youtube.com/*"`
  and `run_at: document_start`. Content script runs early and registers a
  `MutationObserver` on `document.body`.
- **Navigation handling**:
  - Firefox: Use the `navigation` event (if available) or detect `history.pushState`
    + popstate.
  - Fallback: Poll `window.location` every ~100ms and observe URL changes.
- **DOM stability**: Wait for key YouTube containers (`#movie_player`,
  `ytd-watch-flexy`, `ytd-video-primary-info-renderer`) before patching. Retry
  with exponential backoff if they're missing.
- **Selector isolation**: Keep all YouTube-specific selectors centralized in
  `src/content/dom.ts`. If YouTube changes classes, we fix one file.

Example selector structure:

```typescript
// src/content/dom.ts
export const SELECTORS = {
  TITLE: '#video-title, #text.ytd-video-renderer',
  THUMBNAIL: 'ytd-thumbnail #img',
  DESCRIPTION: '#description-ytd-player',
  // ...
};
```

## Options page

Located in `src/options/`. Features:

- AI backend selector (dropdown).
- For key-based backends: API key input (saved encrypted in `browser.storage.local`).
- Frame position configuration (start/middle/end/random/percentage slider).
- Stamp settings: visibility toggle, placement, icon-set alternatives.
- Cache TTL (minutes/hours/days).
- Per-channel allowlist/blocklist.
- Reset cache button.

Design: Minimal, accessible, mobile-responsive. Use CSS variables for theming.

## Testing strategy

### Unit tests

- AI providers: Mock network, verify prompts & outputs.
- Thumbnail math: Verify frame positioning across various resolutions.
- Signal extraction: Test against fixed HTML fixtures.

Use `vitest` with `jsdom` for DOM simulation.

### E2E tests

- Launch headless Firefox and Chrome with the extension loaded.
- Navigate to YouTube (home, search, watch page).
- Assert:
  - Titles are rewritten within 2 seconds.
  - Thumbnails are replaced with frames.
  - Stamps appear near titles with the correct tier from a mocked AI response.
  - Stamp tooltips show the explanation text.
  - Cache prevents duplicate AI calls.
  - Options persist across restarts.

Use `Playwright` with custom fixtures (pre-loaded storyboards, canned
transcripts).

## Contribution guidelines

### Before coding

1. Read the issue tracker. Check for duplicate issues.
2. If adding a major feature, open an issue to discuss design first.
3. Fork the repo and create a branch: `git checkout -b feat/your-feature-name`.

### Writing code

- TypeScript strict mode is enforced.
- Prefer functional, immutable patterns.
- Small, focused modules (<200 lines each).
- Comments explain **why**, not **what**.
- JSDoc for public exports.

### Submitting a PR

1. Ensure `npm test`, `npm run lint`, and `npm run typecheck` pass.
2. Rebase on upstream `main` to avoid merge conflicts.
3. Write conventional commits: `feat: add storyboard parser`, `fix: handle
   missing transcript`.
4. Include a brief description of changes, testing steps, and any breaking
   changes.

## Security considerations

- **API keys**: Never log or leak keys. Store only in `browser.storage.local`
  (encrypted at rest by the browser).
- **CSP**: Default Content Security Policy must not allow unsafe-eval or
  inline scripts.
- **Input validation**: Sanitize all YouTube DOM data before passing to AI.
- **External endpoints**: Validate AI backend URLs (no arbitrary redirects).

## Debugging tips

- Enable extension debugging in Firefox:
  `about:debugging#/runtime/this-firefox` → Inspect extension.
- Use `console.log` with a `[nobait]` prefix for filtering.
- In content scripts, use `window.dispatchEvent(new CustomEvent('nobait:debug'))`
  to trigger diagnostic dumps.
- Playwright traces for E2E: `npm run test:e2e -- --trace on`.

## Release workflow

1. Bump version in `package.json` and `manifest.json`.
2. Tag release: `git tag v1.2.3 && git push origin v1.2.3`.
3. Build both Firefox and Chrome variants.
4. Attach `.xpi` and `.zip` artifacts to GitHub Release.
5. Update changelog in `CHANGELOG.md` (follow Keep-a-Changelog).

## Help for agents

If you're unsure about a decision, prioritize:

1. Firefox compatibility above all.
2. Modularity over cleverness.
3. Privacy over convenience.
4. Simplicity over feature creep.

When in doubt, ask the maintainer or check existing patterns in the codebase.

---

_Last updated: 2026-10-08_
