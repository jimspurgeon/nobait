import { AIInput, StampResult } from "../stamps/types";
import { aiProviderFactory } from "../ai/factory";
import { MODEL_VERSION } from "../ai/gemini";
import { parseStampTier } from "../ai/classify";
import { cacheDB } from "../storage/cache";
import { trace } from "../utils/trace";

/** Timer handle returned by the host's setTimeout (Worker/DOM/Node). */
type TimerHandle = ReturnType<typeof setTimeout>;

interface PendingRequest {
  input: AIInput;
  /** Lower value = flushed earlier (0 = visible/viewport, 1 = normal) */
  priority: number;
  /** Monotonic arrival counter for FIFO among equal priorities */
  seq: number;
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
  private coalesceTimer: TimerHandle | undefined = undefined;

  /** Pending promise callbacks */
  private pendingPromises: PendingRequest[] = [];

  /** Max videos per batch request */
  private readonly MAX_BATCH_SIZE = 20;

  /**
   * Max chunks (of MAX_BATCH_SIZE videos) evaluated per flush cycle.
   * Overflow stays pending and a follow-up flush is scheduled, so the
   * queue drains predictably instead of one giant 30-minute run.
   */
  private readonly MAX_CHUNKS_PER_FLUSH = 2;

  /** Coalescing window in ms */
  private readonly COALESCE_WINDOW_MS = 50;

  /** Listeners for incremental (streaming) results */
  private resultListeners: Set<(result: StampResult) => void> = new Set();

  /** Monotonic arrival counter for FIFO ordering */
  private seqCounter = 0;

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- public for tests
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
   * Add input to pending batch and schedule flush after coalescing window.
   * Priority comes from the `visible` hint on the input: visible (viewport)
   * videos flush ahead of off-screen ones; ties stay FIFO by arrival order.
   */
  private enqueueAndFlush(input: AIInput): Promise<StampResult | null> {
    const { promise, resolve, reject } =
      Promise.withResolvers<StampResult | null>();
    this.pendingPromises.push({
      input,
      priority: input.visible ? 0 : 1,
      seq: this.seqCounter++,
      resolve,
      reject,
    });
    this.pending.set(input.videoId, input);

    this.scheduleFlush();
    return promise;
  }

  /**
   * Start (or reset) the coalescing window, ending in a flush()
   */
  private scheduleFlush(): void {
    clearTimeout(this.coalesceTimer);
    this.coalesceTimer = setTimeout(() => {
      void this.flush();
    }, this.COALESCE_WINDOW_MS);
  }

  /**
   * Flush pending batch to AI provider.
   *
   * Requests are drained in a stable priority order (visible first, then
   * FIFO by arrival). At most MAX_CHUNKS_PER_FLUSH chunks are evaluated per
   * cycle; overflow is kept pending and a follow-up flush is scheduled, so
   * the queue drains predictably and nothing is dropped.
   */
  private async flush(): Promise<void> {
    this.coalesceTimer = undefined;

    if (this.pendingPromises.length === 0) return;

    trace(`FLUSH START count=${this.pendingPromises.length}`);

    // Stable drain order: priority ascending, then arrival (seq) ascending.
    const sorted = [...this.pendingPromises].sort(
      (a, b) => a.priority - b.priority || a.seq - b.seq,
    );
    const maxChunks = Math.min(
      Math.ceil(sorted.length / this.MAX_BATCH_SIZE),
      this.MAX_CHUNKS_PER_FLUSH,
    );

    const queued = sorted.slice(0, maxChunks * this.MAX_BATCH_SIZE);
    const overflow = sorted.slice(maxChunks * this.MAX_BATCH_SIZE);

    // Overflow keeps waiting; re-arm a follow-up flush after this cycle.
    if (overflow.length > 0) {
      this.pendingPromises = overflow;
      for (const req of overflow) {
        this.pending.set(req.input.videoId, req.input);
      }
      this.scheduleFlush();
    } else {
      this.pendingPromises = [];
      this.pending.clear();
    }

    const inputs = queued.map((req) => req.input);
    if (inputs.length === 0) return;

    // Videos already delivered in this flush (streaming may repeat them).
    const handledVideoIds = new Set<string>();

    try {
      // Reuse the background-applied provider; initialize({}) would reset to
      // defaults and silently swap e.g. builtin/smollm2-135m back to qwen.
      const provider =
        aiProviderFactory.getProvider() ??
        (await aiProviderFactory.initialize({}));
      trace(`FLUSH: provider acquired (${provider.name})`);

      // Chunk into groups of MAX_BATCH_SIZE. The canonical AIProvider
      // interface (P4) yields AnalysisResults incrementally via an async
      // iterable; each video's result is emitted + cached on arrival.
      for (let i = 0; i < inputs.length; i += this.MAX_BATCH_SIZE) {
        const chunk = inputs.slice(i, i + this.MAX_BATCH_SIZE);
        trace(
          `FLUSH: chunk ${i / this.MAX_BATCH_SIZE} of ${chunk.length} videos`,
        );
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
          trace(`FLUSH: entering for-await loop over analyzeBatch`);
          trace(`FLUSH: yielded result for ${result.videoId}`);
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
            trace(
              `FLUSH: delivering ${partial.videoId} stamp=${partial.stamp}`,
            );
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
      trace(`FLUSH: batch evaluation FAILED: ${errorMessage}`);
      console.error("[nobait] Batch evaluation failed:", errorMessage);

      // Reject all pending requests
      for (const req of queued) {
        req.reject(err instanceof Error ? err : new Error(errorMessage));
      }
    }
  }

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

  /**
   * Compute hash of input for cache invalidation
   */
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
    clearTimeout(this.coalesceTimer);
    this.coalesceTimer = undefined;
    this.pendingPromises = [];
    this.pending.clear();
    this.inflight.clear();
    this.resultListeners.clear();
  }
}

// Export singleton
export const scheduler = EvaluationScheduler.getInstance();
