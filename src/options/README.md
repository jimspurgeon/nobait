# nobait Options

Configure how nobait works.

## AI Backend

Select the AI backend used to rewrite titles and stamp credibility.

**Backend:** Gemini (Google AI Studio)

## API Key

Your Gemini API key is stored locally in `browser.storage.local`, encrypted at rest by the browser. It is never sent anywhere except to Google's Generative Language API.

## Caching

nobait caches analyses in IndexedDB keyed by video ID, with a 7-day TTL (positive) and 24-hour TTL (negative entries). Cached entries are also invalidated when the model/prompt version changes.
