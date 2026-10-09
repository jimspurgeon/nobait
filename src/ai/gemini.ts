import { parseBatchItem } from "./classify";
import type { AIProvider, AnalysisResult, BatchInput } from "./types";
import { StampTier, isStampTier } from "../stamps/types";

/**
 * Current model version for cache invalidation
 * Bump this when changing prompts or models significantly
 */
export const MODEL_VERSION = "gemini-flash-lite-v1";

/** Models we can fall back to, in preference order (Flash-Lite free tier) */
const STAMP_ENUM = [
  "legitimate",
  "exaggerated",
  "misleading",
  "clickbait",
  "fake",
  "unsure",
];

/**
 * Google AI Studio (Gemini) provider implementation
 * Uses gemini-2.5-flash-lite (Google AI Studio free tier)
 */
export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  readonly supportsStreaming = true;

  private apiKey: string | null = null;
  private apiUrl =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent";
  private timeoutMs = 30000;

  constructor(apiKey?: string) {
    if (apiKey) {
      this.apiKey = apiKey;
    }
  }

  /**
   * Load API key from browser storage
   */
  async loadApiKey(): Promise<void> {
    try {
      const browserApi = (globalThis as any).browser;
      const chromeApi = (globalThis as any).chrome;
      if (typeof browserApi !== "undefined" && browserApi?.storage?.local) {
        const result = await browserApi.storage.local.get(["geminiApiKey"]);
        this.apiKey = result.geminiApiKey || null;
      } else if (
        typeof chromeApi !== "undefined" &&
        chromeApi?.storage?.local
      ) {
        const result = await new Promise<Record<string, string>>((resolve) => {
          chromeApi.storage.local.get(
            ["geminiApiKey"],
            (r: Record<string, string>) => resolve(r),
          );
        });
        this.apiKey = result.geminiApiKey || null;
      }
    } catch (err) {
      console.error("[nobait] Failed to load Gemini API key:", err);
      this.apiKey = null;
    }
  }

  /**
   * Save API key to browser storage (encrypted at rest by the browser)
   */
  async saveApiKey(key: string): Promise<void> {
    const browserApi = (globalThis as any).browser;
    const chromeApi = (globalThis as any).chrome;
    try {
      if (typeof browserApi !== "undefined" && browserApi?.storage?.local) {
        await browserApi.storage.local.set({ geminiApiKey: key });
      } else if (
        typeof chromeApi !== "undefined" &&
        chromeApi?.storage?.local
      ) {
        await new Promise<void>((resolve, reject) => {
          chromeApi.storage.local.set({ geminiApiKey: key }, () => {
            if (chromeApi.runtime?.lastError) {
              reject(chromeApi.runtime.lastError);
            } else {
              resolve();
            }
          });
        });
      }
      this.apiKey = key;
    } catch (err) {
      console.error("[nobait] Failed to save Gemini API key:", err);
      throw err;
    }
  }

  /**
   * Batch analyze up to 20 videos in a single request.
   * Results are parsed chunk-by-chunk as they stream in; onPartialResult
   * fires for each video the moment its chunk completes.
   */
  async analyzeBatchCallback(
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
    }) => void,
  ): Promise<{
    results: Array<{
      videoId: string;
      rewrittenTitle: string;
      stamp: string;
      stampExplanation: string;
    }>;
  }> {
    if (!this.apiKey) {
      await this.loadApiKey();
      if (!this.apiKey) {
        throw new Error("[nobait] Gemini API key not configured");
      }
    }

    if (input.videos.length > 20) {
      throw new Error(
        `[nobait] Batch too large: ${input.videos.length} videos (max 20)`,
      );
    }

    const url = `${this.apiUrl}?key=${encodeURIComponent(this.apiKey)}`;
    const prompt = this.buildBatchPrompt(input.videos);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            topP: 0.8,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                results: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      videoId: { type: "STRING" },
                      rewrittenTitle: { type: "STRING" },
                      stamp: { type: "STRING", enum: STAMP_ENUM },
                      stampExplanation: { type: "STRING" },
                    },
                    required: [
                      "videoId",
                      "rewrittenTitle",
                      "stamp",
                      "stampExplanation",
                    ],
                  },
                },
              },
              required: ["results"],
            },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `[nobait] Gemini API error: ${response.status} - ${errorText}`,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("[nobait] Cannot read response body");
      }

      // Incremental streaming parse: extract each video result the moment
      // its object closes inside the "results" array, validate it strictly,
      // and notify onPartialResult immediately.
      const streamParser = new IncrementalResultParser(onPartialResult);
      const decoder = new TextDecoder();

      let reading = true;
      while (reading) {
        const { value, done } = await reader.read();
        if (done) {
          reading = false;
        } else {
          streamParser.append(decoder.decode(value, { stream: true }));
        }
      }
      streamParser.finish();

      const results = streamParser.getResults();
      if (results.length === 0) {
        throw new Error("[nobait] Failed to parse final JSON response");
      }

      return { results };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Canonical AIProvider entry (P4 interface): yields AnalysisResults as
   * they complete in the streamed response. Internally delegates to
   * analyzeBatchCallback so streaming behavior is unchanged.
   */
  async *analyzeBatch(input: BatchInput): AsyncIterable<AnalysisResult> {
    const videos = input.map((v) => ({
      videoId: v.videoId,
      title: v.title,
      description: v.description,
      transcript: v.transcript,
      chapters: v.chapters?.map((c) => ({ ...c })),
    }));
    const queue: AnalysisResult[] = [];
    let wakeup: (() => void) | undefined;

    const promise = this.analyzeBatchCallback(
      { videos, modelVersion: MODEL_VERSION },
      (partial) => {
        queue.push(toAnalysisResult(partial));
        wakeup?.();
      },
    );

    let settled = false;
    let failure: unknown;
    promise.then(
      (full) => {
        settled = true;
        for (const r of full.results) {
          const ar = toAnalysisResult(r);
          if (!queue.some((q) => q.videoId === ar.videoId)) queue.push(ar);
        }
        wakeup?.();
      },
      (err) => {
        settled = true;
        failure = err;
        wakeup?.();
      },
    );

    let delivered = 0;
    while (true) {
      while (delivered < queue.length) {
        yield queue[delivered]!;
        delivered++;
      }
      if (settled) {
        if (failure !== undefined) throw failure;
        return;
      }
      await new Promise<void>((resolve) => {
        wakeup = resolve;
      });
    }
  }

  /**
   * Build structured prompt for batch analysis
   */
  private buildBatchPrompt(
    videos: Array<{
      videoId: string;
      title: string;
      description?: string;
      transcript?: string;
      chapters?: Array<{ startMs: number; title: string }>;
    }>,
  ): string {
    const videoDescriptions = videos
      .map((video, idx) => {
        const desc = video.description
          ? `\nDescription: ${video.description.substring(0, 500)}`
          : "";
        const chapters = video.chapters?.length
          ? `\nChapters: ${video.chapters.map((c) => `[${Math.round(c.startMs / 1000)}s] ${c.title}`).join(" | ")}`
          : "";
        const transcript = video.transcript
          ? `\nTranscript (first 2000 chars):\n${video.transcript.substring(0, 2000)}`
          : "";

        return `[Video ${idx + 1}] ID: ${video.videoId}\nTitle: ${video.title}${desc}${chapters}${transcript}`;
      })
      .join("\n\n---\n\n");

    return `You are analyzing YouTube video metadata to generate factual titles and credibility ratings.

TASK: Process these ${videos.length} videos and output a JSON object with a "results" array containing EXACTLY these fields for each:
- videoId: the original video ID
- rewrittenTitle: factual, descriptive title (no hype, no ALL CAPS, no clickbait)
- stamp: one of ["legitimate", "exaggerated", "misleading", "clickbait", "fake", "unsure"]
- stampExplanation: one sentence explaining why

STAMP DEFINITIONS:
- legitimate: Title accurately represents content, no manipulation
- exaggerated: True but sensationalized or overstated
- misleading: Title implies something false or incorrect
- clickbait: Withholding information, manufactured curiosity
- fake: Fabricated premise or debunked claim
- unsure: Not enough information to determine

OUTPUT FORMAT: Return ONLY valid JSON. No markdown, no explanations outside JSON.

Examples of good rewritten titles:
- "How to Build a REST API with Node.js and Express" (not "YOU WON'T BELIEVE THIS SIMPLE TRICK!")
- "Climate Change Impact on Arctic Ice 2024" (not "SHOCKING: Ice Disappearing Faster Than Ever!!!")

Here are the videos to analyze:

${videoDescriptions}

Respond with JSON only:`;
  }

  close(): void {
    // No persistent resources for HTTP-based provider
  }
}

/**
 * Incremental parser that extracts video result objects from a JSON stream
 * as they complete. Each fully-received item is validated (strict enum)
 * and emitted immediately via the callback.
 */
export class IncrementalResultParser {
  private buffer = "";
  private emittedIds = new Set<string>();
  private results: Array<{
    videoId: string;
    rewrittenTitle: string;
    stamp: string;
    stampExplanation: string;
  }> = [];
  private finished = false;

  constructor(
    private onPartialResult?: (result: {
      videoId: string;
      rewrittenTitle: string;
      stamp: string;
      stampExplanation: string;
    }) => void,
  ) {}

  /**
   * Feed a decoded stream chunk and extract any newly completed result objects
   */
  append(text: string): void {
    if (this.finished) return;
    this.buffer += text;
    this.extractCompleteItems();
  }

  /**
   * Signal end of stream; try a full-document fallback parse
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;

    if (this.results.length === 0) {
      // Fallback: try to parse the whole accumulated buffer as complete JSON
      const jsonStr = this.buffer
        .trim()
        .replace(/^```json\s*/i, "")
        .replace(/\s*```$/i, "");
      try {
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed?.results)) {
          for (const item of parsed.results) {
            this.acceptValidated(parseBatchItem(item));
          }
        }
      } catch {
        // Unparseable stream - results stay empty; caller raises
      }
    }
  }

  getResults(): Array<{
    videoId: string;
    rewrittenTitle: string;
    stamp: string;
    stampExplanation: string;
  }> {
    return this.results;
  }

  /**
   * Scan the buffer for complete {...} objects inside the results array.
   * Emits each new item as soon as its closing brace arrives.
   */
  private extractCompleteItems(): void {
    // Locate the results array start
    const arrStart = this.buffer.indexOf('"results"');
    if (arrStart === -1) return;
    const bracketPos = this.buffer.indexOf("[", arrStart);
    if (bracketPos === -1) return;

    let i = bracketPos + 1;
    while (i < this.buffer.length) {
      const ch = this.buffer[i];

      if (ch === "]") {
        // End of the results array - everything inside has been emitted
        this.buffer = this.buffer.slice(0, bracketPos); // keep header, drop array
        return;
      }

      if (ch === "{") {
        // Try to find the matching close brace for this object
        let depth = 0;
        let inString = false;
        let escape = false;
        let end = -1;
        for (let j = i; j < this.buffer.length; j++) {
          const c = this.buffer[j];
          if (escape) {
            escape = false;
            continue;
          }
          if (c === "\\") {
            if (inString) escape = true;
            continue;
          }
          if (c === '"') {
            inString = !inString;
            continue;
          }
          if (inString) continue;
          if (c === "{") depth++;
          else if (c === "}") {
            depth--;
            if (depth === 0) {
              end = j;
              break;
            }
          }
        }

        if (end === -1) {
          // Object not complete yet - wait for more chunks
          return;
        }

        const candidate = this.buffer.slice(i, end + 1);
        this.acceptValidated(parseBatchItem(safeParse(candidate)));

        // Continue scanning after this object
        i = end + 1;
      } else {
        i++;
      }
    }
  }

  private acceptValidated(item: ReturnType<typeof parseBatchItem>): void {
    if (!item) return;
    if (this.emittedIds.has(item.videoId)) return;
    this.emittedIds.add(item.videoId);
    this.results.push({
      videoId: item.videoId,
      rewrittenTitle: item.rewrittenTitle,
      stamp: item.stamp,
      stampExplanation: item.stampExplanation,
    });
    this.onPartialResult?.({
      videoId: item.videoId,
      rewrittenTitle: item.rewrittenTitle,
      stamp: item.stamp,
      stampExplanation: item.stampExplanation,
    });
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toAnalysisResult(r: {
  videoId: string;
  rewrittenTitle: string;
  stamp: string;
  stampExplanation: string;
}): AnalysisResult {
  return {
    videoId: r.videoId,
    rewrittenTitle: r.rewrittenTitle,
    stamp: isStampTier(r.stamp)
      ? r.stamp
      : (parseBatchItem(r)?.stamp ?? StampTier.UNSURE),
    stampExplanation: r.stampExplanation,
  };
}
