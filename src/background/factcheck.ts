/**
 * Fact-check layer orchestrator (P6).
 *
 * Owns the full ClaimReview lookup flow described in PLAN.md §3 Stage 4:
 *
 *   1. Trigger check (cheap, no network): FAKE-lean stamp or claim-heavy
 *      topic keywords → maybe fire `claims:search`.
 *   2. API-key gate: absent key ⇒ the layer is a silent no-op.
 *   3. Racing timeout: the lookup races a hard 400 ms AbortController
 *      deadline. Misses are dropped silently and NEVER delay or gate the
 *      title/stamp swap. Late arrivals are ignored (or may refresh the
 *      tooltip if still relevant — see onLateResult).
 *   4. Corroboration: results arriving in time can only strengthen toward
 *      FAKE, never soften.
 *
 * The layer never throws to callers; every failure mode degrades to
 * "no corroboration".
 */

import { StampTier } from "./factcheck-types.js";
import { searchClaims } from "./factcheck-client.js";
import type { FactCheckClaim } from "./factcheck-client.js";
import { shouldLookup } from "./factcheck-trigger.js";
import { applyCorroboration } from "./factcheck-corroborate.js";
import type { CorroborationOutcome } from "./factcheck-corroborate.js";
import type { VideoMeta } from "./factcheck-trigger.js";
import { readSettings } from "../settings/factcheck-settings.js";

export { shouldLookup } from "./factcheck-trigger.js";
export { classifyRating, parseClaimsSearchBody } from "./factcheck-client.js";
export {
  applyCorroboration,
  formatSourceLines,
} from "./factcheck-corroborate.js";
export { StampTier } from "./factcheck-types.js";
export type {
  FactCheckClaim,
  RatingCategory,
  ClaimsSearchResult,
} from "./factcheck-client.js";
export type { CorroborationOutcome, VideoMeta };

/** Hard timeout for the lookup, per the performance budget (PLAN.md §1). */
export const LOOKUP_TIMEOUT_MS = 400;

export interface FactCheckDeps {
  /** Injectable fetch (unit tests mock this). */
  fetchImpl?: typeof fetch;
  /** Injectable settings reader (unit tests mock browser.storage). */
  readSettingsImpl?: typeof readSettings;
  /** Hard timeout in ms; defaults to LOOKUP_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Test hook: called when a result arrives after its deadline. */
  onLateResult?: (videoId: string, result: CorroborationOutcome) => void;
}

/**
 * One fact-check evaluation for a video.
 *
 * NEVER rejects: all failure paths resolve to `{ outcome: 'skipped' | 'timeout' | 'error', result: null }`.
 */
export interface FactCheckEvaluation {
  status: "corroborated" | "no-results" | "skipped" | "timeout" | "error";
  /** Present only when a lookup completed within the deadline. */
  result: CorroborationOutcome | null;
  /** True when the stamp was strengthened to FAKE by corroboration. */
  strengthened: boolean;
  /** Why the layer skipped (debug logging; null when it ran). */
  skipReason?: "disabled" | "no-api-key" | "no-trigger";
}

/** Skipped evaluation singleton (no allocation churn for the common path). */
const SKIPPED_NO_TRIGGER: FactCheckEvaluation = {
  status: "skipped",
  result: null,
  strengthened: false,
  skipReason: "no-trigger",
};

/**
 * No-op outcome constructor preserving the current stamp.
 */
function noChange(currentStamp: StampTier): CorroborationOutcome {
  return {
    stamp: currentStamp,
    changed: false,
    primaryRating: null,
    sourceLines: [],
  };
}

/**
 * Build the search query from video metadata.
 *
 * The title carries the strongest claim signal; we strip common YouTube
 * decoration to keep the query focused.
 */
function buildQuery(meta: VideoMeta): string {
  const title = meta.title
    .replace(/\s*[|(][^)|]*[)]?\s*$/, "") // trailing "(video)" / "| channel" segments
    .trim();
  return title.slice(0, 120);
}

/**
 * Evaluate fact-check corroboration for one video.
 *
 * Callers (the background scheduler) invoke this in parallel with Stage 3
 * AI inference and apply the outcome only if it completes promptly.
 */
export async function evaluateFactCheck(
  videoId: string,
  meta: VideoMeta,
  currentStamp: StampTier,
  deps: FactCheckDeps = {},
): Promise<FactCheckEvaluation> {
  const settings = await (deps.readSettingsImpl ?? readSettings)();

  // Gate 1: API key plumbing — absent key disables the layer entirely.
  if (!settings.enabled) {
    console.debug("[nobait/factcheck] Layer disabled via settings");
    return {
      status: "skipped",
      result: null,
      strengthened: false,
      skipReason: "disabled",
    };
  }
  const apiKey = settings.apiKey?.trim() ?? "";
  if (apiKey === "") {
    console.debug("[nobait/factcheck] Layer disabled: no API key configured");
    return {
      status: "skipped",
      result: null,
      strengthened: false,
      skipReason: "no-api-key",
    };
  }

  // Gate 2: trigger heuristic — cheap keyword check first, no API call for
  // the vast majority of videos.
  const trigger = shouldLookup(meta);
  if (!trigger.should) {
    return SKIPPED_NO_TRIGGER;
  }

  // Gate 3: racing timeout — the fetch MUST complete within the deadline.
  // We use Promise.race so even a misbehaving fetch cannot delay resolution
  // beyond the hard timeout (400ms budget).
  const timeoutMs = deps.timeoutMs ?? settings.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const controller = new AbortController();

  // Track whether the timeout fired (before fetch settles)
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  // Build fetch promise that catches all errors (including abort)
  const fetchPromise: Promise<{
    ok: boolean;
    claims: FactCheckClaim[];
    errored: boolean;
  }> = (async () => {
    try {
      const query = buildQuery(meta);
      const searchResult = await searchClaims(query, apiKey, {
        fetchImpl: deps.fetchImpl,
        signal: controller.signal,
      });
      return { ok: true, claims: searchResult.claims, errored: false };
    } catch (err) {
      // Network errors or abort → treat as error/timeout
      return { ok: false, claims: [], errored: true };
    }
  })();

  // Race: whichever finishes first determines the immediate outcome.
  // A true race — the timer promise resolves on deadline even if the
  // fetch hangs — guarantees we never block longer than timeoutMs.
  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const winner = await Promise.race([
    fetchPromise.then((r) => ({ timedOut: false as const, fetch: r })),
    timeoutPromise,
  ]);

  clearTimeout(timeoutId!);

  if (winner.timedOut) {
    // Timer fired first: this is a timeout. Abort the fetch; if it
    // eventually settles with results and onLateResult is provided,
    // route it to the tooltip-refresh hook (never the swap path).
    controller.abort();
    if (deps.onLateResult != null) {
      fetchPromise
        .then((lateFetch) => {
          if (lateFetch.claims.length > 0) {
            const lateOutcome = applyCorroboration(
              lateFetch.claims,
              currentStamp,
            );
            deps.onLateResult!(videoId, lateOutcome);
          }
        })
        .catch(() => {}); // swallow late errors
    }
    return { status: "timeout" as const, result: null, strengthened: false };
  }

  // Fetch settled before timeout:
  if (winner.fetch.errored) {
    return { status: "error" as const, result: null, strengthened: false };
  }

  // Apply corroboration semantics to the fetched claims.
  const { claims } = winner.fetch;
  if (claims.length === 0) {
    // Absence of results never downgrades — return the unchanged stamp.
    return {
      status: "no-results",
      result: noChange(currentStamp),
      strengthened: false,
    };
  }

  const outcome = applyCorroboration(claims, currentStamp);
  return {
    status: outcome.changed ? "corroborated" : "no-results",
    result: outcome,
    strengthened: outcome.changed,
  };
}
