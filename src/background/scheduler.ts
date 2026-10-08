import { AIInput, StampResult } from "../stamps/types";
import { aiProviderFactory } from "../ai/factory";
import { MODEL_VERSION } from "../ai/gemini";
import { parseStampTier } from "../ai/classify";
import { cacheDB } from "../storage/cache";

interface PendingRequest {
  input: AIInput;
  resolve: (result: StampResult | null) => void;
  reject: (error: Error) => void;
}

/**
 * Coalesces multiple evaluate() calls into single batch requests.
 * Deduplicates concurrent evaluations for the same videoId.
 */
export class EvaluationScheduler {
  private static instance: EvaluationScheduler;

  /** Pending requests waiting to be batched (coalescing window) */
  private pending: Map<string, AIInput> = new Map();

  /** In-flight promises per videoId (deduplication) */
  private inflight: Map<string, Promise<StampResult | null>> = new Map();

  /** Timer for the coalescing window */
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Pending promise callbacks */
  private pendingPromises: PendingRequest[] = [];

  /** Max videos per batch request */
  private readonly MAX_BATCH_SIZE = 20;

  /** Coalescing window in ms */
  private readonly COALESCE_WINDOW_MS = 50;

  /** Listeners for incremental (streaming) results */
  private resultListeners: Set<(result: StampResult) => void> = new Set();

  /** Use getInstance() in application code; constructor is public for tests */
  constructor() {}

  static getInstance(): EvaluationScheduler {
    if (!EvaluationScheduler.instance) {
      EvaluationScheduler.instance = new EvaluationScheduler();
    }
    return EvaluationScheduler.instance;
  }

  /**
   * Register a listener for incremental results
   */
  onResult(listener: (result: StampResult) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  /**
   * Evaluate a video. Duplicate calls for the same videoId share a promise.
   * Calls within the coalescing window merge into one batch request.
   */
  async evaluate(input: AIInput): Promise<StampResult | null> {
    // Check positive cache first (hot path: <= 16ms)
    const cached = await cacheDB.getAnalysis(input.videoId, MODEL_VERSION);
    if (cached) {
      return cached.result;
    }

    // Check negative cache - don't re-pay for known-bad videos
    const negative = await cacheDB.getNegative(input.videoId);
    if (negative) {
      return null;
    }

    // Dedup: if already in flight, share the promise
    const existing = this.inflight.get(input.videoId);
    if (existing) {
      return existing;
    }

    // Create the promise that all callers of this videoId share
    const promise = this.enqueueAndFlush(input);
    this.inflight.set(input.videoId, promise);

    // Clean up inflight entry when settled
    promise.finally(() => this.inflight.delete(input.videoId)).catch(() => {});

    return promise;
  }

  /**
   * Add input to pending batch and schedule flush after coalescing window
   */
  private enqueueAndFlush(input: AIInput): Promise<StampResult | null> {
    return new Promise((resolve, reject) => {
      this.pendingPromises.push({ input, resolve, reject });
      this.pending.set(input.videoId, input);

      // Start (or reset) coalescing window
      if (this.coalesceTimer) {
        clearTimeout(this.coalesceTimer);
      }
      this.coalesceTimer = setTimeout(() => {
        this.flush();
      }, this.COALESCE_WINDOW_MS);
    });
  }

  /**
   * Flush pending batch to AI provider
   */
  private async flush(): Promise<void> {
    this.coalesceTimer = null;

    const queued = [...this.pendingPromises];
    this.pendingPromises = [];
    const inputs = [...this.pending.values()];
    this.pending.clear();

    if (inputs.length === 0) return;

    // Videos already delivered in this flush (streaming may repeat them).
    const handledVideoIds = new Set<string>();

    try {
      const provider = await aiProviderFactory.initialize({});

      // Chunk into groups of 20. The canonical AIProvider interface (P4)
      // yields AnalysisResults incrementally via an async iterable; each
      // video's result is emitted + cached the moment it arrives.
      for (let i = 0; i < inputs.length; i += this.MAX_BATCH_SIZE) {
        const chunk = inputs.slice(i, i + this.MAX_BATCH_SIZE);
        const chunkQueue = queued.filter((req) =>
          chunk.some((c) => c.videoId === req.input.videoId),
        );

        const resultMap = new Map<
          string,
          {
            videoId: string;
            rewrittenTitle: string;
            stamp: string;
            stampExplanation: string;
          }
        >();

        for await (const result of provider.analyzeBatch(chunk)) {
          const partial: {
            videoId: string;
            rewrittenTitle: string;
            stamp: string;
            stampExplanation: string;
          } = {
            videoId: result.videoId,
            rewrittenTitle: result.rewrittenTitle,
            stamp: result.stamp,
            stampExplanation: result.stampExplanation,
          };
          resultMap.set(partial.videoId, partial);

          const req = chunkQueue.find(
            (r) => r.input.videoId === partial.videoId,
          );
          if (req && !handledVideoIds.has(partial.videoId)) {
            handledVideoIds.add(partial.videoId);
            await this.deliverResult(req, partial);
          }
        }

        for (const req of chunkQueue) {
          if (!resultMap.has(req.input.videoId)) {
            // AI didn't return a result for this video
            await cacheDB.setNegative({
              videoId: req.input.videoId,
              reason: "unavailable",
              timestamp: Date.now(),
              ttlMs: 24 * 60 * 60 * 1000,
            });
            req.resolve(null);
          }
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error("[nobait] Batch evaluation failed:", errorMessage);

      // Reject all pending requests
      for (const req of queued) {
        req.reject(err instanceof Error ? err : new Error(errorMessage));
      }
    }
  }

  /**
   * Compute hash of input for cache invalidation
   */
  /**
   * Convert a provider AnalysisResult into a StampResult, cache it, notify
   * listeners, and resolve the originating request.
   */
  private async deliverResult(
    req: PendingRequest,
    partial: {
      videoId: string;
      rewrittenTitle: string;
      stamp: string;
      stampExplanation: string;
    },
  ): Promise<void> {
    const stampResult: StampResult = {
      videoId: partial.videoId,
      rewrittenTitle: partial.rewrittenTitle,
      stamp: parseStampTier(partial.stamp).tier,
      stampExplanation: partial.stampExplanation,
      timestamp: Date.now(),
      modelVersion: MODEL_VERSION,
    };

    // Cache the result
    await cacheDB.setAnalysis({
      videoId: stampResult.videoId,
      result: stampResult,
      inputHash: this.computeInputHash(req.input),
      modelVersion: MODEL_VERSION,
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days TTL
    });

    // Notify listeners (streaming-like incremental delivery)
    this.emitResult(stampResult);
    req.resolve(stampResult);
  }

  private computeInputHash(input: AIInput): string {
    const str = `${input.title}|${input.description || ""}|${input.transcript || ""}|${JSON.stringify(input.chapters)}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  /**
   * Emit result to registered listeners
   */
  private emitResult(result: StampResult): void {
    for (const listener of this.resultListeners) {
      try {
        listener(result);
      } catch (err) {
        console.error("[nobait] Result listener error:", err);
      }
    }
  }

  /**
   * Close scheduler and cleanup
   */
  close(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
    }
    this.pendingPromises = [];
    this.pending.clear();
    this.inflight.clear();
    this.resultListeners.clear();
  }
}

// Export singleton
export const scheduler = EvaluationScheduler.getInstance();
