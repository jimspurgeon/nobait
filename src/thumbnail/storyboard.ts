/**
 * Storyboard spec parsing — placeholder for P2. Will fetch and parse
 * YouTube's storyboard sprite-sheet specs for deterministic frame selection.
 */

export interface StoryboardSpec {
  videoId: string;
  levels: { url: string; columns: number; rows: number; intervalMs: number }[];
}

export function parseStoryboards(
  playerResponse: unknown,
): StoryboardSpec | null {
  // TODO(P2): extract storyboards[] from player_response JSON.
  void playerResponse;
  return null;
}
