/**
 * Video signal extraction — the inputs handed to AI providers.
 *
 * This module is deliberately pure data-shaping (no DOM access): the content
 * script fills {@link VideoSignal} descriptors, the background scheduler
 * enriches them with transcript/description/chapters, and providers consume
 * them. Keeping it data-only makes it trivially testable and lets the same
 * types flow through the message protocol untouched.
 */

/** A chapter marker from the video description or player timeline. */
export interface Chapter {
  startMs: number;
  title: string;
}

/**
 * All evidence gathered for a single video. Every field except `videoId`
 * and `title` is optional — signals that miss their deadline are dropped
 * and the AI evaluates with whatever arrived (PLAN.md §3, Stage 2).
 */
export interface VideoSignal {
  /** YouTube video ID (11 chars). Primary dedupe/cache key. */
  videoId: string;
  /** The original (possibly clickbait) title, verbatim. */
  title: string;
  /** Video description snippet (truncated upstream, already sanitized). */
  description?: string;
  /** Auto or manual transcript text, trimmed to a token budget upstream. */
  transcript?: string;
  /** Chapter markers, if the video has them. */
  chapters?: readonly Chapter[];
  /** Channel display name (helps anchor news/educational context). */
  channel?: string;
}
