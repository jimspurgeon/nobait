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

/**
 * DOM-boundary sanitization (gatekeeper security finding): YouTube DOM
 * text is attacker-controllable (titles, descriptions, channel names).
 * Escape HTML entities before the data crosses into messages / AI
 * backends so markup-looking payloads can't inject into prompts or any
 * downstream HTML rendering. Control characters are stripped too.
 */
export function escapeDomText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- stripping control chars is the point
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Sanitize a whole {@link VideoSignal}-shaped payload at the DOM
 * boundary: escapes title/description/channel (and chapter titles).
 * Returns a new object; the input is never mutated.
 */
export function sanitizeSignal<S extends Partial<VideoSignal>>(signal: S): S {
  const out: S = { ...signal };
  if (out.title !== undefined) out.title = escapeDomText(out.title);
  if (out.description !== undefined)
    out.description = escapeDomText(out.description);
  if (out.channel !== undefined) out.channel = escapeDomText(out.channel);
  if (out.chapters !== undefined) {
    out.chapters = out.chapters.map((c) => ({
      ...c,
      title: escapeDomText(c.title),
    }));
  }
  return out;
}
