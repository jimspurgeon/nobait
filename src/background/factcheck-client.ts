/**
 * Google Fact Check Tools API client — claims:search.
 *
 * REST endpoint (plain fetch, no SDK):
 * GET https://factchecktools.googleapis.com/v1alpha1/claims:search?query=<q>&key=<KEY>
 *
 * API response schema (v1alpha1), per official docs:
 *   {
 *     "claims": [
 *       {
 *         "text": string,            // the claim text
 *         "claimant": string,
 *         "claimDate": string,        // RFC 3339
 *         "claimReview": [            // one or more reviews
 *           {
 *             "publisher": { "name": string, "site": string },
 *             "url": string,
 *             "title": string,
 *             "reviewDate": string,   // RFC 3339 Timestamp
 *             "textualRating": string, // e.g. "Mostly false"
 *             "languageCode": string
 *           }
 *         ]
 *       }
 *     ],
 *     "nextPageToken": string
 *   }
 *
 * Docs: https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/search
 */

export const CLAIMS_SEARCH_ENDPOINT =
  "https://factchecktools.googleapis.com/v1alpha1/claims:search";

/**
 * Normalized ClaimReview entry — one review of one claim.
 */
export interface FactCheckClaim {
  /** Stable-ish id for dedup (hash of claim text + review URL). */
  id: string;

  /** Claim text being reviewed. */
  claimText: string;

  /** Publisher/organization that performed the review. */
  publisher: string;

  /** Site host of the review (e.g. "snopes.com"). */
  publisherSite?: string;

  /** URL of the full review article. */
  reviewUrl: string;

  /** Textual rating from the review (e.g., "False", "Mostly true"). */
  textualRating: string;

  /** Review publication date, RFC 3339 if present. */
  reviewDate?: string;
}

/**
 * Result of a claims:search call.
 */
export interface ClaimsSearchResult {
  /** Reviews flattened from all returned claims. */
  claims: FactCheckClaim[];
}

/**
 * Coarse rating classification used for corroboration semantics.
 */
export type RatingCategory = "false" | "mixed" | "true" | "unclassified";

/** Rating regex clusters, ordered: first match wins. */
const RATING_CLUSTERS: ReadonlyArray<{
  category: RatingCategory;
  pattern: RegExp;
}> = [
  {
    category: "false",
    pattern:
      /\b(false|pants ?on ?fire|debunk(?:ed)?|hoax|fabricat(?:ed|ion)|misinformation|disinformation|pseudoscience|baseless|untrue)\b/i,
  },
  {
    category: "mixed",
    pattern:
      /\b(mixed|mixture|half[- ]true|partly (?:true|false)|partially (?:true|false)|mostly false|needs context|missing context|misleading|cherry[- ]picked|unproven|unsubstantiated)\b/i,
  },
  {
    category: "true",
    pattern:
      /\b(true|accurate|correct|verified|supported|mostly true|largely true|fact[- ]check:? true)\b/i,
  },
];

/**
 * Classify a textual rating (e.g. "Mostly false") into a coarse category.
 * Unknown phrasings → 'unclassified' (which never influences the stamp).
 */
export function classifyRating(textualRating: string): RatingCategory {
  const norm = textualRating.trim();
  if (norm === "") return "unclassified";
  for (const { category, pattern } of RATING_CLUSTERS) {
    if (pattern.test(norm)) return category;
  }
  return "unclassified";
}

/** Deterministic fallback id derived from text content. */
function fallbackId(text: string): string {
  // Cheap non-crypto hash; stable within a session, used for dedup only.
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return `claim-${h >>> 0}`;
}

/** Safely coerce an unknown value to a trimmed string. */
function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * Defensively extract FactCheckClaim entries from a raw Claim object.
 * Malformed shapes yield fewer (or zero) entries, never a throw.
 */
function extractReviewsFromClaim(
  rawClaim: unknown,
  out: FactCheckClaim[],
): void {
  if (rawClaim == null || typeof rawClaim !== "object") return;
  const claim = rawClaim as Record<string, unknown>;

  const claimText =
    asString(claim["text"]) ??
    asString(claim["claimText"]) ??
    "(no claim text)";

  const reviewsRaw = claim["claimReview"];
  const reviewList = Array.isArray(reviewsRaw) ? reviewsRaw : [reviewsRaw];

  for (const reviewRaw of reviewList) {
    if (reviewRaw == null || typeof reviewRaw !== "object") continue;
    const review = reviewRaw as Record<string, unknown>;

    let publisher = "(unknown publisher)";
    let publisherSite: string | undefined;
    const pubRaw = review["publisher"];
    if (pubRaw != null && typeof pubRaw === "object") {
      const pub = pubRaw as Record<string, unknown>;
      publisher = asString(pub["name"]) ?? publisher;
      publisherSite = asString(pub["site"]);
    }

    const reviewUrl = asString(review["url"]) ?? "";
    const textualRating = asString(review["textualRating"]) ?? "(no rating)";
    const reviewDate = asString(review["reviewDate"]);

    if (reviewUrl === "" && textualRating === "(no rating)") continue; // useless entry

    out.push({
      id: fallbackId(`${claimText}|${reviewUrl}`),
      claimText:
        claimText.length > 200 ? `${claimText.slice(0, 197)}...` : claimText,
      publisher,
      publisherSite,
      reviewUrl,
      textualRating,
      reviewDate,
    });
  }
}

/**
 * Parse a claims:search HTTP response body (already JSON-decoded).
 * Tolerates `{}`, non-object bodies, missing/malformed `claims`, and
 * individual malformed Claim entries — those are skipped silently.
 */
export function parseClaimsSearchBody(body: unknown): ClaimsSearchResult {
  const result: ClaimsSearchResult = { claims: [] };
  if (body == null || typeof body !== "object") return result;

  const claimsRaw = (body as Record<string, unknown>)["claims"];
  if (!Array.isArray(claimsRaw)) return result;

  for (const rawClaim of claimsRaw) {
    try {
      extractReviewsFromClaim(rawClaim, result.claims);
    } catch {
      // Malformed entry — skip silently (defensive parsing contract).
    }
  }
  return result;
}

/**
 * Perform a claims:search GET request.
 *
 * The caller supplies the fetch impl and AbortSignal so this stays
 * unit-testable; the background worker passes real fetch + a racing
 * AbortController.
 */
export async function searchClaims(
  query: string,
  apiKey: string,
  opts: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    languageCode?: string;
  } = {},
): Promise<ClaimsSearchResult> {
  const doFetch = opts.fetchImpl ?? fetch;

  const url = new URL(CLAIMS_SEARCH_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("key", apiKey);
  if (opts.languageCode)
    url.searchParams.set("languageCode", opts.languageCode);

  const response = await doFetch(url.toString(), {
    method: "GET",
    signal: opts.signal,
  });

  if (!response.ok) {
    // Non-OK responses are treated as "no results" — the fact-check layer
    // must never surface errors into the swap pipeline.
    return { claims: [] };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { claims: [] }; // malformed JSON body
  }

  return parseClaimsSearchBody(body);
}
