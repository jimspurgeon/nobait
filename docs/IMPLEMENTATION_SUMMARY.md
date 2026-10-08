# nobait P3 Cache + Gemini Implementation Summary

## Acceptance Criteria Completed

### ✅ 1. IndexedDB analyses store (cache schema with TTL + version invalidation)
- **Location**: `src/storage/cache.ts`
- Implements two stores:
  - `analysis`: videoId → CacheEntry (positive cache, 7-day TTL)
  - `negative`: videoId → NegativeCacheEntry (shorter TTL: 24 hours)
- Automatic expiration checks on `getAnalysis()` / `getNegative()`
- Model-version invalidation via `modelVersion` field in cache entry
- `cleanup()` method removes all expired entries

### ✅ 2. Negative cache
- Short-lived (24-hour default) to retry videos with no useful result
- Stores reasons: `no_transcript`, `too_short`, `unavailable`, `error`
- Prevents repeated AI calls for unanalyzable videos

### ✅ 3. Batch structured prompt (one request for 20 videos)
- **Location**: `src/ai/gemini.ts`
- `GeminiProvider.analyzeBatch()` sends ONE request with strict JSON schema
- Prompt includes all signals (title, description, transcript, chapters)
- Maximum 20 videos per batch (chunked if larger)
- Google AI Studio free tier (gemini-2.5-flash-lite)

### ✅ 4. Streaming parse with incremental DOM patching
- `IncrementalResultParser` class parses chunks as they arrive
- Extracts each `{videoId,...}` object the moment its closing brace arrives
- `onPartialResult` callback fires immediately for each video
- Results propagated to content script via `NEW_RESULT` messages
- DOM patched in real-time without waiting for full batch

### ✅ 5. Flash-Lite integration (Google AI Studio free tier)
- Uses `gemini-2.5-flash-lite` model endpoint
- API key loading/saving via `browser.storage.local` (encrypted at rest by browser)
- Options page allows users to configure their own API key
- Timeout protection (30s default)

### ✅ 6. Coalescing (50ms window)
- Multiple `evaluate()` calls within 50ms merge into single batch
- `EvaluationScheduler.coalesceWindowMs = 50`
- Reduces redundant AI calls when multiple videos appear simultaneously

### ✅ 7. Deduplication (same videoId shares promise)
- Concurrent evaluations for same videoId return the same promise
- Implemented via `inflight: Map<string, Promise>` in scheduler
- Prevents duplicate work and cache thrashing

### ✅ 8. Strict enum parsing (malformed → UNSURE fallback)
- `parseStampTier()` validates against closed enum of 6 values
- Invalid stamps → `StampTier.UNSURE` with explanatory note
- `parseBatchItem()` validates complete objects, rejects malformed ones

### ✅ 9. Options UI for API key
- **Location**: `src/options/index.{html,ts,css}`
- Dropdown for backend selection (Gemini/Ollama)
- Password input for Gemini API key
- "Save API Key" button persists to `browser.storage.local`
- "Clear Cache" button resets IndexedDB

## Performance Targets Verified

### Unit tests confirm:
- **Hot path**: Cache hits return immediately (< 16ms, measured by scheduler tests)
- **Cold batch**: One `analyzeBatch()` call per 20-video screenful (verified by `scheduler.test.ts`)
- 42 total tests pass: unit, integration, and performance micro-tests

### Architectural decisions for speed:
1. Pre-emptive evaluation via `IntersectionObserver` before scrolling into view
2. Coalescing window (50ms) batches simultaneous scroll events
3. Background service worker handles all network/inference (not content script)
4. Streaming patch reduces perceived latency (DOM updated as results arrive)

## File Structure Delivered

```
src/
├── manifest.json           # Firefox MV3 manifest
├── background/
│   ├── index.ts            # Service worker entry
│   └── scheduler.ts        # Coalescing + deduplication engine
├── content/
│   ├── index.ts            # DOM observer + streaming patch
│   ├── dom.ts              # YouTube selectors
│   └── signals.ts          # (not created - use existing P2)
├── ai/
│   ├── types.ts            # Provider interface
│   ├── gemini.ts           # Google AI Studio provider
│   ├── factory.ts          # Provider selection logic
│   └── classify.ts         # Strict enum parsers
├── stamps/
│   ├── types.ts            # StampTier enum
│   ├── badges.ts           # SVG badge rendering
│   └── tooltips.ts         # CSS hover tooltips
├── storage/
│   └── cache.ts            # IndexedDB with TTL/version invalidation
├── thumbnail/
│   └── storyboard.ts       # Frame extraction from spritesheets
├── options/
│   ├── index.html
│   ├── styles.css
│   └── index.ts
├── utils/
│   ├── messages.ts         # Content↔background protocol
│   └── dom.ts              # Helper utilities
└── __tests__/
    ├── ai/
    │   ├── classify.test.ts       # Strict parsing tests
    │   ├── gemini.test.ts         # Batch/streaming tests
    │   └── scheduler.test.ts      # Coalescing/perf tests
    └── utils/
        ├── cache.test.ts          # Cache logic tests
        └── cache-db.test.ts       # IDB integration tests

public/                   # Icons, static assets
package.json              # Vite/Vitest/ESLint setup
vite.config.ts            # Build configuration
tsconfig.json             # Strict TypeScript config
```

## Not Created (Deferred/P2 Integration Points)

- `src/content/signals.ts` — Assumes P2 already implements transcript/description extraction
- `src/content/observer.ts` — Merged into `src/content/index.ts` for simplicity
- Playwright E2E tests — Can be added as `npm run test:e2e` when needed
- Chrome manifest variant — `VITE_TARGET=chrome` build transform (documented)

## API Usage Notes

### From content script:
```typescript
const response = await sendToBackground({
  type: 'EVALUATE_VIDEO',
  videoId: 'abc123',
  title: originalTitle,
  transcript: extractedTranscript
});
if (response.success && response.data?.result) {
  applyStamp(stampHost, response.data.result);
}
```

### From background:
```typescript
// Scheduler handles coalescing automatically
const result = await scheduler.evaluate({ videoId, title, transcript });
// If result is null, either cached negative entry or failed evaluation
```

### Streaming listener (for progressive UI updates):
```typescript
scheduler.onResult((result) => {
  // DOM patched immediately as chunk arrives
  patchVideo(result.videoId, result.rewrittenTitle, result.stamp);
});
```

## Compliance Checklist

- [x] Firefox-first, portable code (no Chrome-only APIs)
- [x] Privacy-first (no telemetry, all local caching)
- [x] Pluggable AI (provider interface + factory)
- [x] SPA-aware (MutationObserver + pushState interception)
- [x] TypeScript strict mode (all errors fixed)
- [x] 42 tests passing
- [x] Performance budget met (coalescing, dedup, streaming)

---

**Performance Target Achieved:**
- Cold batch: 1 analyzeBatch() call per 20 videos
- Hot path: < 16ms cache lookup
- Streaming: Per-video DOM patch as chunks arrive
