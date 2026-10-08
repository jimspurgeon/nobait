/**
 * Message protocol between content script and background worker
 */

/** Message types sent from content script to background */
export type ContentToBackgroundMessage =
  | { type: 'EVALUATE_VIDEO'; videoId: string; title: string; description?: string; transcript?: string; chapters?: Array<{ startMs: number; title: string }> }
  | { type: 'GET_CACHE_STATUS' }
  | { type: 'CLEAR_CACHE' }
  | { type: 'SET_GEMINI_API_KEY'; key: string };

/** Message types sent from background to content script */
export type BackgroundToContentMessage =
  | { type: 'NEW_RESULT'; result: { videoId: string; rewrittenTitle: string; stamp: string; stampExplanation: string; timestamp: number; modelVersion: string } }
  | { type: 'CACHE_STATUS'; analysisCount: number; negativeCount: number }
  | { type: 'CACHE_CLEARED' }
  | { type: 'API_KEY_SET' };

/** Generic response envelope */
export interface MessageResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * Send a message to the background worker (from content script)
 */
export async function sendToBackground<T>(message: ContentToBackgroundMessage): Promise<MessageResponse<T>> {
  const api = typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null;
  if (!api?.runtime?.sendMessage) {
    throw new Error('[nobait] No runtime message API available');
  }

  if (typeof browser !== 'undefined') {
    return await browser.runtime.sendMessage(message);
  } else {
    return await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response: MessageResponse<T>) => handleCallbackResponse(response, resolve, reject));
    });
  }
}

function handleCallbackResponse<T>(response: MessageResponse<T> | null, resolve: (v: MessageResponse<T>) => void, reject: (e: Error) => void): void {
  if (chrome.runtime.lastError) {
    reject(new Error(chrome.runtime.lastError.message));
  } else {
    resolve(response || { success: false, error: 'No response from background' });
  }
}
