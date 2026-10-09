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
  | { type: "SET_GEMINI_API_KEY"; key: string };

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
 */
export async function sendToBackground<T>(
  message: ContentToBackgroundMessage,
): Promise<MessageResponse<T>> {
  const runtimeApi = webext.runtime;
  if (!runtimeApi?.sendMessage) {
    throw new Error("[nobait] No runtime message API available");
  }

  return (await runtimeApi.sendMessage(message)) as MessageResponse<T>;
}
