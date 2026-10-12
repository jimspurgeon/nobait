/**
 * Content→background sprite fetch bridge.
 *
 * YouTube's sprite CDN (i.ytimg.com) does not send CORS headers, so a
 * content-script `fetch()` cannot read the response body. The background
 * script holds host permissions for `*://*.ytimg.com/*`, which exempts it
 * from CORS — so sprite bytes are fetched there and handed back as a
 * structured-cloned `Uint8Array`.
 */

import type { MessageResponse } from "../utils/messages";
import { webext } from "../utils/webext";

interface SpriteFetchResponse extends MessageResponse {
  data?: { bytes?: Uint8Array };
}

async function spriteViaBackground(url: string): Promise<Uint8Array | null> {
  const runtimeApi = webext.runtime;
  if (!runtimeApi?.sendMessage) {
    throw new Error("nobait: runtime messaging unavailable");
  }
  const resp = (await runtimeApi.sendMessage({
    type: "nobait:fetch-sprite",
    url,
  })) as SpriteFetchResponse | undefined;
  if (!resp || !resp.success) {
    return null;
  }
  return resp.data?.bytes ?? null;
}

export { spriteViaBackground };
