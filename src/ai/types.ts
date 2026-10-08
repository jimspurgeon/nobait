/**
 * AI provider contracts (AGENTS.md "AI provider implementation guide").
 *
 * The canonical batch interface (`AIProvider`, P4): providers yield
 * `AnalysisResult`s incrementally via an async iterable, so callers need
 * no branching for streaming vs non-streaming backends. `supportsStreaming`
 * is informational — `false` just means results may all arrive in one chunk.
 *
 * Implementations MUST:
 *   - never mutate the input batch or its nested objects;
 *   - yield one result per input video, in input order preferred but not
 *     required;
 *   - fall back to `UNSURE` + original-title passthrough on ANY parse
 *     ambiguity rather than throwing mid-stream;
 *   - reject with descriptive `Error` objects on infrastructure failure
 *     (network down, timeout exceeded, model unavailable);
 *   - respect the hard timeout injected via constructor config.
 */
import type { StampTier } from "../stamps/types.js";
import type { VideoSignal } from "../content/signals.js";

export type { StampTier, VideoSignal };

/** Result of analyzing ONE video. */
export interface AnalysisResult {
  /** The video this verdict belongs to (echoed from the batch input). */
  videoId: string;
  /**
   * Factual, neutral replacement title. May equal the original when the
   * original was already honest. On parse failure / provider error, this is
   * the ORIGINAL title passed through untouched (silent degradation —
   * PLAN.md §1 "Anything failing → degrade silently").
   */
  rewrittenTitle: string;
  /**
   * Credibility stamp for the video's ORIGINAL framing (never the
   * rewritten title — see AGENTS.md "Credibility stamps").
   */
  stamp: StampTier;
  /** 1–2 sentence, evidence-grounded justification for the stamp. */
  stampExplanation: string;
}

/** A batch of videos to analyze in one provider round trip. */
export type BatchInput = readonly VideoSignal[];

/** Pluggable AI provider contract. */
export interface AIProvider {
  readonly name: string;
  /**
   * Whether the provider can stream partial output. All providers still
   * implement `analyzeBatch` as an async iterable so callers need no
   * branching; `false` just means results may all arrive in one chunk.
   */
  readonly supportsStreaming: boolean;

  /**
   * Analyze a batch of videos, yielding per-video results as they parse.
   * Batches are capped by the scheduler (≤ 20 videos, PLAN.md §4); a
   * provider receiving more than 20 SHOULD split internally.
   */
  analyzeBatch(input: BatchInput): AsyncIterable<AnalysisResult>;

  /** Optional cleanup on shutdown (close sessions, abort in-flight work). */
  close?(): void;
}

/**
 * Shapes carried over from the P3 Gemini implementation for stream
 * parsing (kept as a plain data contract, no behavioral coupling).
 */
export interface BatchVideoResult {
  videoId: string;
  rewrittenTitle: string;
  /** Raw string tier — MUST be validated via parseStampTier/isStampTier. */
  stamp: string;
  stampExplanation: string;
}
