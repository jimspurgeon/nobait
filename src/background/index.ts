import { scheduler } from "./scheduler";
import { cacheDB } from "../storage/cache";
import { aiProviderFactory } from "../ai/factory";
import { GeminiProvider } from "../ai/gemini";
import { AIInput, StampResult } from "../stamps/types";
import { evaluateFactCheck, StampTier as FactCheckTier } from "./factcheck";

declare const browser: any;
declare const chrome: any;

/**
 * Background service worker entry point — handles stamp pipeline (P3/P4)
 * and cache-management messages (P2 thumbnail pipeline coordination).
 */
class BackgroundWorker {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    console.log("[nobait] Initializing background worker...");

    // Initialize cache database
    await cacheDB.init();

    // Initialize AI provider factory
    await aiProviderFactory.initialize({});

    // Set up message handler
    this.setupMessageHandler();

    // Periodic cleanup (hourly)
    setInterval(() => cacheDB.cleanup().catch(console.error), 60 * 60 * 1000);

    this.initialized = true;
    console.log("[nobait] Background worker initialized");
  }

  /**
   * Handle messages from content scripts
   */
  private setupMessageHandler(): void {
    const handleMessage = (
      message: { type?: string; [key: string]: any },
      _sender: unknown,
      sendResponse: (response: any) => void,
    ): boolean => {
      switch (message.type) {
        case "EVALUATE_VIDEO": {
          this.handleEvaluateVideo({
            videoId: message.videoId,
            title: message.title,
            description: message.description,
            transcript: message.transcript,
            chapters: message.chapters,
          })
            .then(sendResponse)
            .catch((err) =>
              sendResponse({ success: false, error: String(err) }),
            );
          return true; // Async response
        }

        case "GET_CACHE_STATUS":
          this.getCacheStatus()
            .then(sendResponse)
            .catch((err) =>
              sendResponse({ success: false, error: String(err) }),
            );
          return true;

        case "CLEAR_CACHE":
          this.clearCache()
            .then(sendResponse)
            .catch((err) =>
              sendResponse({ success: false, error: String(err) }),
            );
          return true;

        case "SET_GEMINI_API_KEY":
          this.setGeminiApiKey(message.key)
            .then(() => sendResponse({ success: true }))
            .catch((err) =>
              sendResponse({ success: false, error: String(err) }),
            );
          return true;

        case "nobait:clear-thumb-cache": {
          void this.clearThumbCaches().then(() => {
            // P2 style reply (service-worker postMessage)
          });
          sendResponse({ success: true });
          return true;
        }

        default:
          console.warn("[nobait] Unknown message type:", message.type);
          sendResponse({ success: false, error: "Unknown message type" });
          return false;
      }
    };

    // Firefox WebExtensions API
    const runtimeApi =
      typeof browser !== "undefined" && browser?.runtime?.onMessage
        ? browser.runtime
        : typeof chrome !== "undefined" && chrome?.runtime?.onMessage
          ? chrome.runtime
          : null;

    if (runtimeApi) {
      runtimeApi.onMessage.addListener(handleMessage);
    } else {
      console.error("[nobait] No runtime message API available");
    }

    // Subscribe to incremental results for streaming DOM patching
    scheduler.onResult((result: StampResult) => {
      this.broadcastResult(result);
    });
  }

  /**
   * Handle evaluate video request
   */
  private async handleEvaluateVideo(payload: {
    videoId: string;
    title: string;
    description?: string;
    transcript?: string;
    chapters?: Array<{ startMs: number; title: string }>;
  }): Promise<{ success: boolean; result?: StampResult }> {
    const input: AIInput = {
      videoId: payload.videoId,
      title: payload.title,
      description: payload.description,
      transcript: payload.transcript,
      chapters: payload.chapters,
    };

    // Fact-check layer (P6): runs in parallel with AI inference and can
    // only strengthen a FAKE-leaning stamp, never delay or soften it.
    const factCheckPromise = evaluateFactCheck(
      input.videoId,
      { title: input.title, description: input.description ?? "" },
      FactCheckTier.UNSURE,
    );

    const result = await scheduler.evaluate(input);
    const factCheck = await factCheckPromise;

    if (result && factCheck.result && factCheck.result.changed) {
      result.stamp = factCheck.result.stamp;
    }
    return { success: true, result: result || undefined };
  }

  /**
   * Get cache statistics
   */
  private async getCacheStatus(): Promise<{
    success: boolean;
    analysisCount: number;
    negativeCount: number;
  }> {
    return { success: true, analysisCount: 0, negativeCount: 0 };
  }

  /**
   * Clear all caches
   */
  private async clearCache(): Promise<{ success: boolean }> {
    await cacheDB.close();
    await cacheDB.init();
    return { success: true };
  }

  /**
   * Set Gemini API key (persisted via provider)
   */
  private async setGeminiApiKey(key: string): Promise<void> {
    const provider = await aiProviderFactory.initialize({});
    if (provider instanceof GeminiProvider) {
      await provider.saveApiKey(key);
    }
  }

  /**
   * Broadcast result to all YouTube tabs (for streaming updates)
   */
  private async broadcastResult(result: StampResult): Promise<void> {
    const tabsApi =
      typeof browser !== "undefined" && browser?.tabs
        ? browser.tabs
        : typeof chrome !== "undefined" && chrome?.tabs
          ? chrome.tabs
          : null;

    if (!tabsApi) return;

    const message = { type: "NEW_RESULT", result };

    try {
      const tabs = await tabsApi.query({});
      for (const tab of tabs as any[]) {
        if (tab.id != null) {
          try {
            await tabsApi.sendMessage(tab.id, message);
          } catch {
            // Tab may not have our content script - ignore
          }
        }
      }
    } catch {
      // Tab messaging unavailable - ignore
    }
  }

  /**
   * Clear thumbnail-related IndexedDB databases (P2 pipeline coordination)
   */
  private async clearThumbCaches(): Promise<void> {
    for (const name of ["nobait-thumbnails", "nobait-sprites"]) {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    }
  }
}

// Initialize on service worker startup
const worker = new BackgroundWorker();
void worker.init().catch((err) => {
  console.error("[nobait] Failed to initialize background worker:", err);
});

export default worker;
