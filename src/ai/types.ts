/**
 * AI provider interface - all providers must implement this
 */
export interface AIProvider {
  readonly name: string;
  readonly supportsStreaming: boolean;

  analyze(input: {
    title: string;
    description?: string;
    transcript?: string;
    chapters?: Array<{ startMs: number; title: string }>;
  }): Promise<{
    rewrittenTitle: string;
    stamp: string;
    stampExplanation: string;
  }>;

  /**
   * Optional batch analysis for improved performance.
   * onPartialResult (if provided) receives each video's result as soon as
   * its chunk completes in the streamed response.
   */
  analyzeBatch?(
    input: {
      videos: Array<{
        videoId: string;
        title: string;
        description?: string;
        transcript?: string;
        chapters?: Array<{ startMs: number; title: string }>;
      }>;
      modelVersion: string;
    },
    onPartialResult?: (result: {
      videoId: string;
      rewrittenTitle: string;
      stamp: string;
      stampExplanation: string;
    }) => void
  ): Promise<{
    results: Array<{
      videoId: string;
      rewrittenTitle: string;
      stamp: string;
      stampExplanation: string;
    }>;
  }>;

  close?(): void;
}
