/**
 * Credibility stamp tiers - closed enum for strict parsing
 */
export enum StampTier {
  LEGITIMATE = 'legitimate',     // ✓ green - accurate, honest, matches content
  EXAGGERATED = 'exaggerated',   // ⚠ yellow - true but overstated/sensationalized
  MISLEADING = 'misleading',     // ✗ red - title implies something false
  CLICKBAIT = 'clickbait',       // 🎣 orange - withholding, manufactured curiosity
  FAKE = 'fake',                 // ☠️ dark red - fabricated premise/debunked
  UNSURE = 'unsure'              // ? gray - insufficient signal data
}

/**
 * Valid stamp tier values for runtime validation
 */
export const VALID_STAMP_TIERS = Object.values(StampTier);

/**
 * Stamp result from AI analysis
 */
export interface StampResult {
  videoId: string;
  rewrittenTitle: string;
  stamp: StampTier;
  stampExplanation: string; // 1-2 sentences
  timestamp: number;
  modelVersion: string;
}

/**
 * Negative cache entry for videos that couldn't be analyzed
 */
export interface NegativeCacheEntry {
  videoId: string;
  reason: 'no_transcript' | 'too_short' | 'unavailable' | 'error';
  timestamp: number;
  ttlMs: number; // Shorter TTL than positive cache
}

/**
 * Cache entry structure
 */
export interface CacheEntry {
  videoId: string;
  result: StampResult;
  inputHash: string; // Hash of title+description+transcript for invalidation
  modelVersion: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * AI provider input data
 */
export interface AIInput {
  videoId: string;
  title: string;
  description?: string;
  transcript?: string;
  chapters?: Array<{ startMs: number; title: string }>;
  viewCount?: number;
}

/**
 * Batch evaluation input (up to 20 videos)
 */
export interface BatchAIInput {
  videos: AIInput[];
  modelVersion: string;
}

/**
 * Individual result in a batch response
 */
export interface BatchVideoResult {
  videoId: string;
  rewrittenTitle: string;
  stamp: string; // Raw string, must be validated
  stampExplanation: string;
}

/**
 * Full batch response
 */
export interface BatchAIResponse {
  results: BatchVideoResult[];
  modelVersion: string;
  processingTimeMs?: number;
}
