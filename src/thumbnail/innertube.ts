/**
 * Fetches the `player_response` JSON for a video via YouTube's InnerTube
 * API. Cached sprite specs + blobs mean this only runs cold.
 *
 * We mimic the web client's `player` endpoint which returns the same
 * `storyboards` object the page itself consumes. No API key beyond the
 * public web-app key is used.
 */

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`;

interface InnertubeContext {
  client: {
    clientName: string;
    clientVersion: string;
    hl?: string;
    gl?: string;
  };
}

const WEB_CONTEXT: InnertubeContext = {
  client: {
    clientName: 'WEB',
    clientVersion: '2.20240101.00.00',
    hl: 'en',
    gl: 'US',
  },
};

export async function fetchPlayerResponse(
  videoId: string,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const body = {
    context: WEB_CONTEXT,
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const resp = await fetchImpl(PLAYER_URL, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`nobait/innertube: player endpoint ${resp.status}`);
  }
  return resp.json();
}
