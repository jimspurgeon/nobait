/**
 * Shared prompt building + strict response parsing for ALL providers
 * (Ollama, Gemini, Chrome built-in AI — PLAN.md §8 `ai/classify.ts`).
 *
 * Discipline enforced here, per AGENTS.md "Credibility stamps":
 *   - the model must output STRICT JSON, one tier from the closed enum;
 *   - ratings are grounded in transcript/description evidence — popularity
 *     is never punished on its own;
 *   - the stamp rates the video's ORIGINAL framing, not the rewrite;
 *   - any parse ambiguity falls back to UNSURE, never throws.
 */

import { StampTier, isStampTier } from "../stamps/types.js";
import type { AnalysisResult } from "./types.js";
import type { VideoSignal } from "../content/signals.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max videos per provider round trip (PLAN.md §3 Stage 3). */
export const MAX_BATCH_SIZE = 20;

/** Rough character budget per signal field — keeps prompts bounded. */
const MAX_FIELD_CHARS = 1200;

/**
 * Bumped whenever prompt wording changes materially; part of the cache key
 * so stale analyses invalidate gracefully (PLAN.md §5 model-version-tagged
 * cache).
 */
export const PROMPT_VERSION = 1;

/**
 * Value object shape accepted by the parser (duck-typed against raw JSON),
 * then exposed as a const for consumers/tests.
 */
export interface ParsedVerdict {
  id: string;
  title: string;
  tier: StampTier;
  reason: string;
}

const SYSTEM_RULES = [
  "You rate YouTube videos and rewrite their titles honestly.",
  "For EACH video input, output ONE JSON object with exactly these fields:",
  '  "id" (copy verbatim from the input), "title" (your rewritten title),',
  '  "tier" (exactly one of the six lowercase values listed below), and',
  '  "reason" (one short sentence citing evidence from the signals).',
  "Tier meanings:",
  "  legitimate — title accurately describes the content; honest framing.",
  "  exaggerated — content is real but the title overstates it or sensationalizes.",
  "  misleading — title implies something the content does not deliver.",
  "  clickbait — title withholds key info to manufacture curiosity (e.g. 'you won't believe…').",
  "  fake — fabricated premise, staged event presented as real, or debunked claim.",
  "  unsure — signals are too weak to judge honestly.",
  "Ground rules:",
  "1. Rate the ORIGINAL title's framing — never rate your own rewrite.",
  "2. Ground every rating in evidence from the description/transcript.",
  "3. Never punish a title merely for being popular, emotional, or informal.",
  "4. When evidence is missing or mixed, choose 'unsure' — do not guess.",
  "5. Your rewritten title must be factual, specific, and neutral in tone.",
  "Respond with a single JSON array of objects, one per video, in input order.",
  "No markdown fences, no commentary — JSON only.",
];

/**
 * Ground-rule block shared by every provider's prompt (stable wording is a
 * cache-invalidation concern — see PROMPT_VERSION).
 */
export const CLASSIFY_SYSTEM_PROMPT = SYSTEM_RULES.join("\n");

// ---------------------------------------------------------------------------
// Input sanitation
// ---------------------------------------------------------------------------

/**
 * Collapses control chars/newlines to spaces and truncates hard so hostile
 * or huge YouTube DOM data can neither break JSON nor blow the token budget.
 * Pure — returns a new string; input is never mutated (unit-tested).
 */
export function sanitize(text: string, maxChars: number = MAX_FIELD_CHARS): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? flat.slice(0, maxChars - 1) + "…" : flat;
}

/**
 * Serializable copy of a {@link VideoSignal}: only defined fields, all
 * strings sanitized. The original object is untouched (immutability rule).
 */
export function toPromptVideo(video: VideoSignal): Record<string, string> {
  const out: Record<string, string> = {
    id: sanitize(video.videoId, 32),
    title: sanitize(video.title, 300),
  };
  if (video.channel !== undefined) {
    out.channel = sanitize(video.channel, 120);
  }
  if (video.description !== undefined) {
    out.description = sanitize(video.description);
  }
  if (video.transcript !== undefined) {
    out.transcript = sanitize(video.transcript);
  }
  if (video.chapters !== undefined && video.chapters.length > 0) {
    out.chapters = sanitize(
      video.chapters.map((c) => `${Math.floor(c.startMs / 1000)}s ${c.title}`).join("; "),
      600,
    );
  }
  return out;
}

/**
 * Builds the user-message part of the batch prompt.
 * Exported for tests and providers that assemble prompts differently.
 */
export function buildBatchUserPrompt(batch: readonly VideoSignal[]): string {
  const payload = batch.map(toPromptVideo);
  return `Analyze these ${batch.length} video(s):\n${JSON.stringify(payload)}`;
}

// ---------------------------------------------------------------------------
// Strict response parsing
// ---------------------------------------------------------------------------

/**
 * Extracts the outermost JSON array from raw model text. Handles the two
 * failure shapes small models actually produce: markdown fences and leading
 * chatter before the JSON. Returns `null` when nothing array-shaped exists.
 */
export function extractJsonArray(raw: string): unknown[] | null {
  // strip markdown fences if present (```json ... ``` or ``` ... ```)
  const unfenced = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Coerce ONE raw object (already `typeof === "object"`) into a ParsedVerdict
 * or `null` on any ambiguity. Strict: wrong types, missing fields, unknown
 * tiers, or empty strings all reject.
 */
function coerceVerdict(entry: unknown): ParsedVerdict | null {
  if (typeof entry !== "object" || entry === null) return null;
  const rec = entry as Record<string, unknown>;
  const { id, title, tier, reason } = rec;
  if (typeof id !== "string" || typeof title !== "string" || typeof reason !== "string") {
    return null;
  }
  if (!isStampTier(tier)) return null;
  const cleanTitle = title.trim();
  const cleanReason = reason.trim();
  if (cleanTitle.length === 0 || cleanReason.length === 0) return null;
  return { id, title: cleanTitle, tier, reason: cleanReason };
}

/** Fallback result used for any video the model failed to rate. */
export function unsureResult(video: VideoSignal): AnalysisResult {
  return {
    videoId: video.videoId,
    rewrittenTitle: video.title, // silent degradation — keep the original
    stamp: StampTier.UNSURE,
    stampExplanation: "The AI response could not be parsed confidently.",
  };
}

/**
 * STRICT batch parser — the single funnel every provider pipes model output
 * through. Guarantees, regardless of model garbage:
 *
 * - one {@link AnalysisResult} per input video, covering the whole batch
 *   (missing/invalid entries become UNSURE + original-title passthrough);
 * - input order is preserved;
 * - never throws.
 */
export function parseBatchResponse(
  raw: string,
  batch: readonly VideoSignal[],
): AnalysisResult[] {
  if (batch.length === 0) return [];

  const arr = extractJsonArray(raw);
  const verdicts =
    arr === null
      ? []
      : arr
          .map((entry) => coerceVerdict(entry))
          .filter((v): v is ParsedVerdict => v !== null);

  // Exact-id matches win first; duplicated ids keep their first verdict.
  const byId = new Map<string, ParsedVerdict>();
  const leftovers: ParsedVerdict[] = [];
  for (const v of verdicts) {
    if (!byId.has(v.id) && batch.some((s) => s.videoId === v.id)) {
      byId.set(v.id, v);
    } else {
      leftovers.push(v);
    }
  }

  const results: AnalysisResult[] = [];
  let leftoverCursor = 0;
  for (const signal of batch) {
    const verdict = byId.get(signal.videoId) ?? leftovers[leftoverCursor++];
    if (verdict === undefined) {
      results.push(unsureResult(signal));
      continue;
    }
    results.push({
      videoId: signal.videoId,
      rewrittenTitle: verdict.title,
      stamp: verdict.tier,
      stampExplanation: verdict.reason,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Legacy strict enum parsing (Gemini provider, P3)
// ---------------------------------------------------------------------------

/**
 * Parse a raw string into a StampTier with strict validation.
 * Any malformed value falls back to UNSURE.
 */
export function parseStampTier(raw: unknown): { tier: StampTier; explanation?: string } {
  if (typeof raw !== "string") {
    return { tier: StampTier.UNSURE, explanation: "Stamp was not a string" };
  }
  const normalized = raw.trim().toLowerCase();
  if (!isStampTier(normalized)) {
    return {
      tier: StampTier.UNSURE,
      explanation: `Unknown stamp "${raw}" - defaulted to unsure`,
    };
  }
  return { tier: normalized };
}

/**
 * Parse a full batch result item (Gemini shape: videoId/rewrittenTitle/
 * stamp/stampExplanation) with strict validation. Malformed items fall
 * back to UNSURE with explanation, or null if unusable.
 */
export function parseBatchItem(raw: unknown): {
  videoId: string;
  rewrittenTitle: string;
  stamp: StampTier;
  stampExplanation: string;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.videoId !== "string" || obj.videoId.length === 0) return null;
  if (typeof obj.rewrittenTitle !== "string" || obj.rewrittenTitle.length === 0)
    return null;
  const stampParsed = parseStampTier(obj.stamp);
  const explanation =
    typeof obj.stampExplanation === "string" && obj.stampExplanation.length > 0
      ? obj.stampExplanation
      : stampParsed.explanation ?? "No explanation provided";
  return {
    videoId: obj.videoId,
    rewrittenTitle: obj.rewrittenTitle,
    stamp: stampParsed.tier,
    stampExplanation: explanation,
  };
}
