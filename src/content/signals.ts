/**
 * nobait — Signal extraction (titles, descriptions, transcripts).
 *
 * P1 placeholder: the interface the content script will use to collect
 * signals for the AI backends arriving in P3.
 */

export interface VideoSignals {
  videoId: string;
  title: string;
  description?: string;
  transcript?: string;
  chapters?: Array<{ startMs: number; title: string }>;
}

export async function collectSignals(videoId: string): Promise<VideoSignals> {
  // TODO(P3): fetch description/chapters/transcript via InnerTube.
  return { videoId, title: "" };
}
