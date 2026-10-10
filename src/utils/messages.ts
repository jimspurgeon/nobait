/**
 * Message protocol between content script and background worker
 */

import { webext } from "./webext";

/** Message types sent from content script to background */
export type ContentToBackgroundMessage =
  | {
      type: "EVALUATE_VIDEO";
      videoId: string;
      title: string;
      description?: string;
      transcript?: string;
      chapters?: Array<{ startMs: number; title: string }>;
    }
  | { type: "GET_CACHE_STATUS" }
  | { type: "CLEAR_CACHE" }
  | { type: "SET_GEMINI_API_KEY"; key: string }
  | { type: "GET_PROVIDER_STATUS" }
  | { type: "VALIDATE_GEMINI_KEY"; key: string }
  | { type: "nobait:clear-thumb-cache" }
  | { type: "nobait:fetch-sprite"; url: string }
  | { type: "GET_WASM_STATUS" }
  | { type: "KEEPALIVE_PING" };

/** Message types sent from background to content script */
export type BackgroundToContentMessage =
  | {
      type: "NEW_RESULT";
      result: {
        videoId: string;
        rewrittenTitle: string;
        stamp: string;
        stampExplanation: string;
        timestamp: number;
        modelVersion: string;
      };
    }
  | { type: "CACHE_STATUS"; analysisCount: number; negativeCount: number }
  | { type: "CACHE_CLEARED" }
  | { type: "API_KEY_SET" };

/** Generic response envelope */
export interface MessageResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * Send a message to the background worker (from content script).
 *
 * The background listener returns Promises (Firefox-native
 * OnMessageListenerAsync pattern), so `sendMessage` resolves with the
 * listener's resolved value directly — no sendResponse callback round
 * trip, identical shape on Firefox and Chrome.
 *
 * For EVALUATE_VIDEO, starts a background keepalive ping loop (every 10s)
 * to prevent Firefox event-page idle teardown. The background side treats
 * KEEPALIVE_PING as a cheap ack that resets the idle timer (issue #8).
 */
export async function sendToBackground<T>(
  message: ContentToBackgroundMessage,
): Promise<MessageResponse<T>> {
  const runtimeApi = webext.runtime;
  if (!runtimeApi?.sendMessage) {
    throw new Error("[nobait] No runtime message API available");
  }

  // Start keepalive ping loop for slow EVALUATE_VIDEO calls.
  let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  if (message.type === "EVALUATE_VIDEO") {
    keepaliveInterval = setInterval(() => {
      void Promise.resolve(
        runtimeApi.sendMessage({ type: "KEEPALIVE_PING" }),
      ).catch(() => {
        /* background may be shutting down — fine */
      });
    }, 10_000);
  }

  try {
    return (await runtimeApi.sendMessage(message)) as MessageResponse<T>;
  } finally {
    if (keepaliveInterval !== null) {
      clearInterval(keepaliveInterval);
    }
  }
}
