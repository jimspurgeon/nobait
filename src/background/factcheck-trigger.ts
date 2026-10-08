/**
 * Trigger heuristics for the fact-check layer.
 *
 * Design goal: the fact-check lookup is opt-in garnish, not gating. We fire
 * only when (a) the AI's preliminary stamp leans FAKE, or (b) the
 * title/description hits claim-heavy topic keywords. Cheap keyword check
 * first — no network for the vast majority of videos.
 */

/** A claim-heavy topic keyword configuration (extensible via options). */
export interface TopicKeywordConfig {
  /** Keyword lists keyed by topic area; matched case-insensitively. */
  topics: Record<string, string[]>;
}

/**
 * Starter keyword set: news, health, finance, politics.
 * Intentionally extensible — the options UI can extend/replace entries.
 */
export const DEFAULT_TOPIC_KEYWORDS: Readonly<TopicKeywordConfig> = {
  topics: {
    news: [
      'news', 'breaking', 'reported', 'according to', 'sources say',
      'exclusive', 'leaked', 'announced', 'press conference',
      'journalist', 'headline', 'coverage', 'official', 'authorities',
      'crisis', 'eyewitness', 'footage', 'statement',
    ],
    health: [
      'cure', 'miracle cure', 'doctors', 'vaccine', 'vaccines',
      'big pharma', 'fda', 'side effects', 'cancer', 'diabetes',
      'weight loss', 'supplement', 'supplements', 'detox', 'immune system',
      'anti-vax', 'antivax', 'fluoride', 'autism', 'study finds',
      'scientists warn', 'wellness', 'nutrition', 'medication', 'health',
    ],
    finance: [
      'stock', 'stocks', 'market crash', 'crash', 'economy', 'economic',
      'recession', 'inflation', 'gdp', 'federal reserve', 'interest rates',
      'tax', 'taxes', 'investment', 'investments', 'crypto', 'bitcoin',
      'ethereum', 'nft', 'get rich', 'millionaire', 'billionaire',
      'debt', 'loan', 'mortgage', 'bankruptcy', 'ponzi', 'pyramid scheme',
      'scam', 'fraud', 'insider trading',
    ],
    politics: [
      'election', 'elections', 'president', 'presidential', 'voter',
      'voting', 'ballot', 'candidate', 'senator', 'congress',
      'parliament', 'prime minister', 'lawmaker', 'executive order',
      'impeachment', 'immigration', 'border', 'dictator', 'regime',
      'protest', 'coup', 'scandal', 'partisan', 'democrat', 'republican',
      'conservative', 'liberal', 'left-wing', 'right-wing', 'politics',
    ],
  },
};

/**
 * Minimal video metadata needed by the trigger.
 */
export interface VideoMeta {
  /** Preliminary stamp from AI classification, if computed yet. */
  preliminaryStamp?: string | null;
  /** Video title (original, not rewritten). */
  title: string;
  /** Video description, if known. */
  description?: string;
}

/** Reason a lookup fired (or didn't) — used in debug logging. */
export type TriggerReason =
  | 'fake-lean'
  | 'topic-keyword'
  | 'no-trigger';

/** Outcome of evaluating the trigger. */
export interface TriggerDecision {
  should: boolean;
  reason: TriggerReason;
  /** Topic area that matched (topic-keyword only). */
  matchedTopic?: string;
  /** Keyword that matched (topic-keyword only). */
  matchedKeyword?: string;
}

/** Stamp tiers that lean "fabricated premise". */
const FAKE_LEAN_TIERS = new Set(['fake']);

/**
 * Cheap keyword test — whole-word for single words, substring for phrases.
 */
function textMatchesKeywords(
  lowerHaystack: string,
  tokens: Set<string>,
  keywords: readonly string[],
): string | null {
  for (const keyword of keywords) {
    if (keyword.includes(' ')) {
      if (lowerHaystack.includes(keyword)) return keyword;
    } else if (tokens.has(keyword)) {
      return keyword;
    }
  }
  return null;
}

/**
 * Determine whether a fact-check lookup should fire for a video.
 *
 * Order (cheapest first):
 * 1. Preliminary stamp leans FAKE → fire.
 * 2. Claim-heavy topic keywords in title/description → fire.
 * 3. Otherwise → no lookup (the vast majority of videos).
 */
export function shouldLookup(
  meta: VideoMeta,
  config: TopicKeywordConfig = DEFAULT_TOPIC_KEYWORDS,
): TriggerDecision {
  // 1. FAKE-leaning preliminary stamp — trivially cheap check.
  if (meta.preliminaryStamp != null && FAKE_LEAN_TIERS.has(meta.preliminaryStamp)) {
    return { should: true, reason: 'fake-lean' };
  }

  // 2. Claim-heavy topic keyword check.
  const combined = `${meta.title}\n${meta.description ?? ''}`;
  const lowerHaystack = combined.toLowerCase();
  const tokens = new Set(
    lowerHaystack.split(/[^a-z0-9']+/).filter(Boolean),
  );

  for (const [topic, keywords] of Object.entries(config.topics)) {
    const matched = textMatchesKeywords(lowerHaystack, tokens, keywords);
    if (matched != null) {
      return { should: true, reason: 'topic-keyword', matchedTopic: topic, matchedKeyword: matched };
    }
  }

  return { should: false, reason: 'no-trigger' };
}
