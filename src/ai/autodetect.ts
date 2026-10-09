/**
 * Ollama auto-detection (zero-config out-of-box experience).
 *
 * When no AI backend is configured, the background worker probes the
 * standard local Ollama ports and, if a server answers, silently adopts
 * the best installed model. This keeps nobait privacy-first (local-only
 * inference, no accounts, no keys) while making the extension useful the
 * moment it is installed on a machine that already runs Ollama.
 */

import { SUGGESTED_MODELS } from "./ollama.js";

/** A reachable local server + the model chosen from its catalog. */
export interface DetectedOllama {
  /** Normalized origin, e.g. `http://localhost:11434`. */
  url: string;
  /** Model tag served by that origin, e.g. `qwen3:0.6b`. */
  model: string;
}

/** Default candidate origins, tried in order. */
const PROBE_ORIGINS: readonly string[] = Object.freeze([
  "http://localhost:11434",
  "http://127.0.0.1:11434",
]);

interface TagsEntry {
  name?: string;
  size?: number;
}

interface TagsResponse {
  models?: TagsEntry[];
}

/** Heuristic bonus for general-purpose instruct models (lower = better). */
function modelRank(name: string): number {
  const lower = name.toLowerCase();
  // Exact / prefix matches to the suggested list win outright.
  for (let i = 0; i < SUGGESTED_MODELS.length; i++) {
    const s = SUGGESTED_MODELS[i]?.toLowerCase() ?? "";
    if (lower === s) return i;
    if (s && lower.startsWith(s.split(":")[0] ?? "")) return 10 + i;
  }
  // Generic chat models next.
  if (lower.includes("llama") || lower.includes("qwen") || lower.includes("mistral")) return 100;
  if (lower.includes("gemma") || lower.includes("phi") || lower.includes("smol")) return 110;
  // Embeddings / code models are useless for this task.
  if (lower.includes("embed")) return 1000;
  if (lower.includes("code")) return 900;
  return 500;
}

/**
 * Fetch the model catalog from one origin.
 * @returns parsed entries, or `null` when the server is unreachable or the
 *          response is not valid Ollama `/api/tags` JSON.
 */
async function fetchTags(
  origin: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<TagsEntry[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(`${origin}/api/tags`, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const body = (await resp.json()) as TagsResponse;
    return Array.isArray(body.models) ? body.models : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the local machine for a running Ollama server and pick the most
 * suitable installed model.
 *
 * @param fetchFn Injectable fetch (tests / service-worker binding).
 * @param timeoutMs Per-origin probe timeout. Kept short: this runs between
 *        startup and the first AI call, so a dead port must not stall.
 * @returns the detected server + model, or `null` when nothing usable runs.
 */
export async function detectOllama(
  fetchFn: typeof fetch = fetch,
  timeoutMs = 750,
): Promise<DetectedOllama | null> {
  for (const origin of PROBE_ORIGINS) {
    const models = await fetchTags(origin, fetchFn, timeoutMs);
    if (!models || models.length === 0) continue;

    const usable = models
      .filter((m): m is TagsEntry & { name: string } =>
        typeof m.name === "string" && m.name.length > 0,
      )
      .map((m) => ({ name: m.name, size: m.size ?? Infinity }))
      // Rank by suitability first, then by disk size (small = faster).
      .sort(
        (a, b) =>
          modelRank(a.name) - modelRank(b.name) || a.size - b.size,
      );

    if (usable.length > 0) {
      const name = usable[0]?.name;
      if (name) return { url: origin, model: name };
    }
  }
  return null;
}
