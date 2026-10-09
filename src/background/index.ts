import { scheduler } from "./scheduler";
import { cacheDB } from "../storage/cache";
import { aiProviderFactory } from "../ai/factory";
import { GeminiProvider } from "../ai/gemini";
import { AIInput, StampResult } from "../stamps/types";
import { evaluateFactCheck, StampTier as FactCheckTier } from "./factcheck";
import { webext } from "../utils/webext";
import {
  getSettings,
  onSettingsChanged,
  CACHE_TTL_MS,
} from "../settings/index";

// Re-export for the scheduler's TTL computation (avoids a circular import
// of the settings module shape into scheduler.ts's static constants).
export { CACHE_TTL_MS };

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

    // Initialize AI provider factory from unified settings
    const settings = await getSettings();
    await this.applyAiSettings(settings);

    // Set up message handler
    this.setupMessageHandler();

    // Live settings: re-initialize the provider when AI config changes.
    onSettingsChanged((next) => {
      void this.applyAiSettings(next);
    });

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
      rawMessage: unknown,
      _sender: unknown,
      _sendResponse?: (response: unknown) => void,
    ): boolean | Promise<unknown> => {
      const message = (rawMessage ?? {}) as {
        type?: string;
        [key: string]: unknown;
      };
      const msg = message as Partial<{
        videoId: string;
        title: string;
        description: string;
        transcript: string;
        chapters: Array<{ startMs: number; title: string }>;
        key: string;
      }>;

      // Firefox-native pattern: return a Promise for async responses
      // (OnMessageListenerAsync signature). Chrome also supports this.
      switch (message.type) {
        case "EVALUATE_VIDEO":
          return this.handleEvaluateVideo({
            videoId: msg.videoId ?? "",
            title: msg.title ?? "",
            description: msg.description,
            transcript: msg.transcript,
            chapters: msg.chapters,
          }).catch((err: unknown) => ({
            success: false,
            error: String(err),
          }));

        case "GET_CACHE_STATUS":
          return this.getCacheStatus().catch((err: unknown) => ({
            success: false,
            error: String(err),
          }));

        case "CLEAR_CACHE":
          return this.clearCache().catch((err: unknown) => ({
            success: false,
            error: String(err),
          }));

        case "SET_GEMINI_API_KEY":
          return this.setGeminiApiKey(String(msg.key ?? ""))
            .then(() => ({ success: true }))
            .catch((err: unknown) => ({
              success: false,
              error: String(err),
            }));

        case "nobait:clear-thumb-cache":
          return this.clearThumbCaches().then(
            () => ({ success: true }) as const,
          );

        default:
          console.warn("[nobait] Unknown message type:", message.type);
          return Promise.resolve({
            success: false,
            error: "Unknown message type",
          });
      }
    };

    const runtimeApi = webext.runtime;

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
   * Feed unified settings into the provider factory. The user's backend
   * preference (options dropdown) selects the provider chain: a specific
   * backend pins the factory to it, `auto` follows the default chain.
   */
  private async applyAiSettings(
    settings: Awaited<ReturnType<typeof getSettings>>,
  ): Promise<void> {
    await aiProviderFactory.reset();
    const ai = settings.ai;
    await aiProviderFactory.initialize({
      preferredProvider: ai.backend === "auto" ? undefined : ai.backend,
      geminiApiKey: ai.geminiApiKey || undefined,
      ollamaUrl: ai.ollamaUrl || undefined,
      ollamaModel: ai.ollamaModel || undefined,
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
  }): Promise<{
    success: boolean;
    result?: StampResult & {
      timing?: { inferenceMs: number; cached?: boolean };
    };
    error?: string;
  }> {
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

    const startedAt = performance.now();
    const result = await scheduler.evaluate(input);
    const inferenceMs = Math.round(performance.now() - startedAt);
    const factCheck = await factCheckPromise;

    if (result && factCheck.result && factCheck.result.changed) {
      result.stamp = factCheck.result.stamp;
    }
    // Timing context for the content script's animation layer (M2):
    // cached hits animate instantly, live inference scales durations.
    const timedResult = result
      ? {
          ...result,
          timing: { inferenceMs, cached: inferenceMs < 50 },
        }
      : undefined;
    return { success: true, result: timedResult };
  }

  /**
   * Get cache statistics
   */
  private async getCacheStatus(): Promise<{
    success: boolean;
    analysisCount: number;
    negativeCount: number;
  }> {
    try {
      const counts = await cacheDB.counts();
      return { success: true, ...counts };
    } catch (err) {
      console.error("[nobait] Failed to read cache stats:", err);
      return { success: false, analysisCount: 0, negativeCount: 0 };
    }
  }

  /**
   * Clear all caches
   */
  private async clearCache(): Promise<{ success: boolean }> {
    await cacheDB.clearAll();
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
    const tabsApi = webext.tabs;

    if (!tabsApi) return;

    // Age of the result drives animation timing: fresh results animate,
    // anything older than a few seconds came from cache/stream replay.
    const ageMs = Date.now() - result.timestamp;
    const message = {
      type: "NEW_RESULT",
      result: {
        ...result,
        timing: { inferenceMs: ageMs, cached: ageMs < 50 },
      },
    };

    try {
      const tabs = await tabsApi.query({});
      for (const tab of tabs) {
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
