/**
 * Fetches the `player_response` JSON for a video via YouTube's InnerTube
 * API. The API key is never hardcoded: it is extracted at runtime from the
 * page's own configuration (`window.ytcfg.get('INNERTUBE_API_KEY')`),
 * which YouTube's bootstrap installs before our content script runs.
 *
 * In Firefox content scripts run in an isolated world, so the page's
 * `ytcfg` is reachable through `window.wrappedJSObject`. When no key can
 * be found (non-YouTube context, stripped-down page), InnerTube fetching
 * is disabled: a single `[nobait]` warning is logged and callers degrade
 * to whatever cached thumbnails they already have.
 */

let warned = false;

/**
 * Read the InnerTube API key from the page's runtime configuration.
 * Returns null when unavailable — callers must treat that as
 * "InnerTube disabled".
 */
export function getInnerTubeApiKey(): string | null {
  const candidates: Array<Record<string, unknown> | undefined | null> = [
    (globalThis as Record<string, unknown>).ytcfg as
      Record<string, unknown> | undefined,
    (globalThis as { wrappedJSObject?: { ytcfg?: Record<string, unknown> } })
      .wrappedJSObject?.ytcfg,
  ];
  for (const cfg of candidates) {
    try {
      if (cfg && typeof cfg.get === "function") {
        const key = (cfg.get as (k: string) => unknown)("INNERTUBE_API_KEY");
        if (typeof key === "string" && key.length > 0) return key;
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function warnDisabled(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "[nobait] ytcfg INNERTUBE_API_KEY unavailable — InnerTube fetching disabled; " +
      "thumbnail specs will come from cache only.",
  );
}

/** Build the player endpoint URL for a given runtime-extracted key. */
export function playerEndpointUrl(apiKey: string): string {
  return `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`;
}

const CLIENT_CONTEXT = {
  client: {
    // ANDROID client: unaffected by the WEB client's attestation/PO-token
    // tightening (since late 2025 "WEB" player responses return
    // UNPLAYABLE "Video unavailable" for requests without a PO token,
    // which killed storyboard spec fetching). ANDROID still returns full
    // player payloads — and works with plain content-script fetches (no
    // restricted headers, no UA spoofing needed).
    clientName: "ANDROID",
    clientVersion: "20.10.38",
    androidSdkVersion: 30,
    hl: "en",
    gl: "US",
  },
} as const;

/**
 * Fetch the `player_response` for `videoId`. Rejects when the InnerTube
 * key cannot be extracted at runtime (thumbnail pipeline degrades to
 * cache hits and the original thumbnails stay visible).
 */
export async function fetchPlayerResponse(
  videoId: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<unknown> {
  const apiKey = getInnerTubeApiKey();
  if (!apiKey) {
    warnDisabled();
    throw new Error(
      "nobait/innertube: INNERTUBE_API_KEY unavailable at runtime",
    );
  }

  const resp = await fetchImpl(playerEndpointUrl(apiKey), {
    method: "POST",
    credentials: "omit",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      context: CLIENT_CONTEXT,
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  if (!resp.ok) {
    throw new Error(`nobait/innertube: player endpoint ${resp.status}`);
  }
  return resp.json();
}
