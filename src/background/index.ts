import { scheduler } from "./scheduler";
import { cacheDB } from "../storage/cache";
import { aiProviderFactory } from "../ai/factory";
import { GeminiProvider } from "../ai/gemini";
import { AIInput, StampResult } from "../stamps/types";
import { evaluateFactCheck, StampTier as FactCheckTier } from "./factcheck";
import { webext } from "../utils/webext";
import { detectOllama } from "../ai/autodetect";
import {
  getWasmStatus,
  setWasmDownloadProgressSink,
  WasmProvider,
} from "../ai/wasm";
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
 *
 * Firefox MV3 event-page note: Firefox treats background.scripts as a
 * non-persistent event page that idles out after ~30s without extension-API
 * activity. Long-running work (wllama model download/inference) must call
 * `touchKeepalive()` periodically to reset the idle timer (see #8).
 */
class BackgroundWorker {
  private initialized = false;
  /** Human-readable name of the active provider, for the options UI. */
  private activeProvider: string | null = null;
  /** Init failure reason, surfaced through GET_PROVIDER_STATUS. */
  private initError: string | null = null;
  /** Keepalive interval id during model warmup (Firefox event-page gate). */
  private keepaliveId: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;

    console.log("[nobait] Initializing background worker...");

    try {
      // Broadcast built-in model download progress to the options page and
      // (via tabs fan-out) to content scripts in YouTube tabs, which drive
      // the status chip. runtime.sendMessage alone reaches extension pages
      // only — content scripts never see it (that was the invisible-download
      // bug this fixes).
      setWasmDownloadProgressSink(({ loaded, total }) => {
        const message = { type: "MODEL_DOWNLOAD_PROGRESS", loaded, total };
        const runtimeApi = webext.runtime;
        if (!runtimeApi) return;
        void Promise.resolve(runtimeApi.sendMessage(message)).catch(() => {
          /* no listener (options page closed) — fine */
        });
        void this.broadcastToTabs(message);
      });

      // Register the message handler FIRST — a slow Ollama autodetect probe
      // (or any future init step) must never delay responsiveness to
      // content scripts.
      this.setupMessageHandler();

      // Initialize cache database
      await cacheDB.init();

      // Watch for settings changes BEFORE the (slow) initial apply: the
      // Ollama autodetect probe inside applyAiSettings can take seconds,
      // and a storage write landing in that window must not be missed
      // (issue #9). Applies are serialized so a change arriving mid-startup
      // can't interleave with the initial provider build.
      let settingsWrite = Promise.resolve();
      const applySerialized = (s: Awaited<ReturnType<typeof getSettings>>) => {
        settingsWrite = settingsWrite.then(() => this.applyAiSettings(s));
        return settingsWrite;
      };
      onSettingsChanged((next) => {
        void applySerialized(next).catch(console.error);
      });
      await applySerialized(await getSettings());

      // Periodic cleanup (hourly)
      setInterval(() => cacheDB.cleanup().catch(console.error), 60 * 60 * 1000);

      this.initialized = true;
      console.log("[nobait] Background worker initialized");
    } catch (err) {
      // Surface the failure through GET_PROVIDER_STATUS instead of leaving
      // content scripts to wonder why EVALUATE_VIDEO silently does nothing.
      this.initError = String(err);
      console.error("[nobait] Failed to initialize background worker:", err);
    }
  }

  /**
   * Handle messages from content scripts
   */
  private setupMessageHandler(): void {
    const handleMessage = async (
      rawMessage: unknown,
      _sender: unknown,
      _sendResponse?: (response: unknown) => void,
    ): Promise<unknown> => {
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
        url: string;
      }>;

      // Firefox-native pattern: return a Promise for async responses
      // (OnMessageListenerAsync signature). Chrome also supports this.
      switch (message.type) {
        case "EVALUATE_VIDEO":
          // Slow inference/model download: the sending content script polls
          // KEEPALIVE_PING (incoming messages reset Firefox's event-page
          // idle timer) for the duration of this call — see src/utils/messages.ts.
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

        case "GET_PROVIDER_STATUS":
          return Promise.resolve({
            success: true,
            provider: this.activeProvider,
            detectedLocal: this.detectedLocal,
            initError: this.initError,
          });

        case "GET_WASM_STATUS":
          return Promise.resolve({
            success: true,
            status: getWasmStatus(),
          });

        case "VALIDATE_GEMINI_KEY": {
          const key = String(msg.key ?? "").trim();
          if (!key) {
            return Promise.resolve({
              success: false,
              error: "empty key",
            });
          }
          // Cheapest possible authenticated call: list model names.
          try {
            const resp = await fetch(
              "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
              { headers: { "x-goog-api-key": key } },
            );
            if (resp.ok) return { success: true };
            const body = (await resp.json().catch(() => ({}))) as {
              error?: { message?: string };
            };
            return {
              success: false,
              error: body.error?.message ?? `HTTP ${resp.status}`,
            };
          } catch (cause) {
            return { success: false, error: String(cause) };
          }
        }

        case "KEEPALIVE_PING":
          // Incoming message resets Firefox event-page idle timer — just ack.
          return Promise.resolve({ success: true });

        case "nobait:clear-thumb-cache":
          return this.clearThumbCaches().then(
            () => ({ success: true }) as const,
          );

        case "nobait:fetch-sprite": {
          // Sprite fetches are proxied through the background because
          // i.ytimg.com serves no CORS headers: content-script fetch()
          // cannot read the body, but the background's host_permissions
          // exempt it from CORS entirely.
          const url = String(msg.url ?? "");
          return fetch(url, { credentials: "omit" })
            .then(async (resp: Response) => {
              if (!resp.ok) {
                return { success: false, error: `sprite fetch ${resp.status}` };
              }
              const blob = await resp.blob();
              // Structured-cloneable representation of the bytes.
              const buf = await blob.arrayBuffer();
              return {
                success: true,
                data: { bytes: new Uint8Array(buf) },
              };
            })
            .catch((err: unknown) => ({
              success: false,
              error: String(err),
            }));
        }

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
   *
   * Zero-config path: when the user has configured nothing at all, probe
   * the local machine for a running Ollama server and silently adopt it
   * (detected once per worker lifetime, memoized into `detectedLocal`).
   */
  private detectedLocal: { url: string; model: string } | null = null;
  private detectedLocalProbed = false;

  private async applyAiSettings(
    settings: Awaited<ReturnType<typeof getSettings>>,
  ): Promise<void> {
    const ai = settings.ai;
    const nothingConfigured =
      !ai.geminiApiKey &&
      !(ai.ollamaUrl && ai.ollamaModel) &&
      ai.backend !== "chrome";
    if (nothingConfigured && !this.detectedLocalProbed) {
      this.detectedLocal = await detectOllama(globalThis.fetch).catch(
        (e: unknown) => {
          console.warn("[nobait] Local AI autodetect failed:", e);
          return null;
        },
      );
      console.log(this.detectedLocal ?? "none");
      this.detectedLocalProbed = true;
      if (this.detectedLocal) {
        console.log(
          "[nobait] Auto-detected local Ollama:",
          this.detectedLocal.url,
          this.detectedLocal.model,
        );
      }
    }

    await aiProviderFactory.reset();
    await aiProviderFactory.initialize({
      preferredProvider: ai.backend === "auto" ? undefined : ai.backend,
      geminiApiKey: ai.geminiApiKey || undefined,
      ollamaUrl: ai.ollamaUrl || this.detectedLocal?.url,
      ollamaModel: ai.ollamaModel || this.detectedLocal?.model,
      builtinModel: ai.builtinModel,
    });
    this.activeProvider = aiProviderFactory.getCurrentProviderName();

    // Download-on-install: when the zero-config builtin WASM provider is
    // active, eagerly download/load the model so the user's first YouTube
    // visit doesn't stall behind an ~88 MB download. Fire-and-forget —
    // failures are logged but never block EVALUATE_VIDEO (first analyze
    // retries lazily). Only fires once per worker lifetime (once-successful
    // wllama caches the model in OPFS, so restarts load from disk quickly).
    const provider = aiProviderFactory.getProvider();
    if (provider instanceof WasmProvider) {
      void this.warmupBuiltin(provider);
    }
  }

  /**
   * Warm up the builtin WASM provider with a keepalive heartbeat. Firefox
   * event pages idle out after ~30s without extension-API activity; the
   * wllama download runs entirely in workers and won't reset the timer on
   * its own (issue #8 pattern). A cheap runtime.getManifest() call every
   * 20s keeps the worker alive until the download completes.
   */
  private warmupBuiltin(provider: WasmProvider): Promise<void> {
    if (this.keepaliveId !== null) return Promise.resolve();
    this.keepaliveId = setInterval(() => {
      // Any extension-API call resets the idle timer.
      try {
        webext.runtime?.getManifest?.();
      } catch {
        /* worker tearing down — stop the heartbeat */
        this.clearWarmupKeepalive();
      }
    }, 20_000);
    const done = () => this.clearWarmupKeepalive();
    return provider
      .warmup()
      .then(() => {
        console.log("[nobait] builtin model warmed up");
        done();
      })
      .catch((err: unknown) => {
        console.warn("[nobait] builtin model warmup failed:", err);
        done();
      });
  }

  private clearWarmupKeepalive(): void {
    if (this.keepaliveId !== null) {
      clearInterval(this.keepaliveId);
      this.keepaliveId = null;
    }
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
   * Send a message to every YouTube tab's content script (progress fan-out).
   * Non-YouTube tabs without our content script reject — ignored.
   */
  private async broadcastToTabs(message: unknown): Promise<void> {
    const tabsApi = webext.tabs;
    if (!tabsApi) return;
    try {
      const tabs = await tabsApi.query({ url: "*://*.youtube.com/*" });
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
worker.init().catch((err) => {
  // init() already captures the error internally for GET_PROVIDER_STATUS;
  // this outer catch only guards against errors thrown before the internal
  // try block begins (e.g. constructing the download-progress sink).
  console.error("[nobait] Background worker init promise rejected:", err);
});

export default worker;
