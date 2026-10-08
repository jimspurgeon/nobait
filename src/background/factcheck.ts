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

import { StampTier } from './factcheck-types.js';
import {
  searchClaims,
} from './factcheck-client.js';
import type { FactCheckClaim } from './factcheck-client.js';
import { shouldLookup } from './factcheck-trigger.js';
import { applyCorroboration } from './factcheck-corroborate.js';
import type { CorroborationOutcome } from './factcheck-corroborate.js';
import type { VideoMeta } from './factcheck-trigger.js';
import {
  readSettings,
} from '../settings/factcheck-settings.js';

export { shouldLookup } from './factcheck-trigger.js';
export { classifyRating, parseClaimsSearchBody } from './factcheck-client.js';
export { applyCorroboration, formatSourceLines } from './factcheck-corroborate.js';
export { StampTier } from './factcheck-types.js';
export type {
  FactCheckClaim,
  RatingCategory,
  ClaimsSearchResult,
} from './factcheck-client.js';
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
  status: 'corroborated' | 'no-results' | 'skipped' | 'timeout' | 'error';
  /** Present only when a lookup completed within the deadline. */
  result: CorroborationOutcome | null;
  /** True when the stamp was strengthened to FAKE by corroboration. */
  strengthened: boolean;
  /** Why the layer skipped (debug logging; null when it ran). */
  skipReason?: 'disabled' | 'no-api-key' | 'no-trigger';
}

/** Skipped evaluation singleton (no allocation churn for the common path). */
const SKIPPED_NO_TRIGGER: FactCheckEvaluation = {
  status: 'skipped',
  result: null,
  strengthened: false,
  skipReason: 'no-trigger',
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
    .replace(/\s*[|(][^)|]*[)]?\s*$/, '') // trailing "(video)" / "| channel" segments
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
    console.debug('[nobait/factcheck] Layer disabled via settings');
    return { status: 'skipped', result: null, strengthened: false, skipReason: 'disabled' };
  }
  const apiKey = settings.apiKey?.trim() ?? '';
  if (apiKey === '') {
    console.debug('[nobait/factcheck] Layer disabled: no API key configured');
    return { status: 'skipped', result: null, strengthened: false, skipReason: 'no-api-key' };
  }

  // Gate 2: trigger heuristic — cheap keyword check first, no API call for
  // the vast majority of videos.
  const trigger = shouldLookup(meta);
  if (!trigger.should) {
    return SKIPPED_NO_TRIGGER;
  }

  // Gate 3: racing timeout — the fetch must complete within the deadline.
  const timeoutMs = deps.timeoutMs ?? settings.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);

  // Track lateness so a slow-but-successful fetch is routed to the
  // tooltip-refresh path instead of the (already-settled) swap path.
  let timedOut = false;
  const onTimeout = () => { timedOut = true; };
  controller.signal.addEventListener('abort', onTimeout);

  let claims: FactCheckClaim[] = [];
  let errored = false;
  try {
    const query = buildQuery(meta);
    const searchResult = await searchClaims(query, apiKey, {
      fetchImpl: deps.fetchImpl,
      signal: controller.signal,
    });
    claims = searchResult.claims;
  } catch {
    // Aborts (timeout) and network errors both land here — silently dropped.
    errored = true;
  } finally {
    clearTimeout(deadline);
    controller.signal.removeEventListener('abort', onTimeout);
  }

  // Late arrival: past the deadline, the swap has (by contract) already
  // settled. Drop it, or hand it to the optional tooltip-refresh hook.
  if (timedOut) {
    if (errored && deps.onLateResult == null) {
      return { status: 'timeout', result: null, strengthened: false };
    }
    // Even a successful fetch past the deadline is a "miss".
    if (deps.onLateResult != null && claims.length > 0) {
      // Compose outcome for the tooltip-refresh consumer only.
      const lateOutcome = applyCorroboration(claims, currentStamp);
      deps.onLateResult(videoId, lateOutcome);
    }
    return { status: 'timeout', result: null, strengthened: false };
  }

  if (errored) {
    return { status: 'error', result: null, strengthened: false };
  }

  // In-time arrival: apply corroboration semantics.
  if (claims.length === 0) {
    // Absence of results never downgrades — return the unchanged stamp.
    return {
      status: 'no-results',
      result: noChange(currentStamp),
      strengthened: false,
    };
  }

  const outcome = applyCorroboration(claims, currentStamp);
  return {
    status: outcome.changed ? 'corroborated' : 'no-results',
    result: outcome,
    strengthened: outcome.changed,
  };
}
