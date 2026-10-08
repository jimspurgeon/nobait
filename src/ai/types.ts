/**
 * Stub AI provider interface — concrete backends arrive in P3/P4.
 *
 * Kept here now so later phases can implement against a stable contract
 * without touching core wiring.
 */
import type { StampTier } from "../stamps/types";

export interface AnalyzeInput {
  videoId: string;
  title: string;
  description?: string;
  transcript?: string;
  chapters?: Array<{ startMs: number; title: string }>;
}

export interface AnalyzeResult {
  rewrittenTitle: string;
  stamp: StampTier;
  stampExplanation: string;
}

export interface AIProvider {
  readonly name: string;
  readonly supportsStreaming: boolean;

  analyze(input: AnalyzeInput): Promise<AnalyzeResult>;

  /** Cleanup on shutdown. */
  close?(): void;
}
