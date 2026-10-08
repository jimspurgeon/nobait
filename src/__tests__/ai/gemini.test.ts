import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiProvider, MODEL_VERSION, IncrementalResultParser } from '../../ai/gemini';
import { StampTier } from '../../stamps/types';

describe('GeminiProvider', () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    provider = new GeminiProvider('test-api-key');
  });

  describe('analyzeBatch - prompt construction', () => {
    it('sends ONE request for up to 20 videos with structured JSON output', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          results: Array.from({ length: 3 }, (_, i) => ({
            videoId: `vid-${i}`,
            rewrittenTitle: `Honest title ${i}`,
            stamp: 'legitimate',
            stampExplanation: `Explanation ${i}`
          }))
        }), { status: 200 })
      );

      const videos = [
        { videoId: 'vid-0', title: 'CLICKBAIT 1' },
        { videoId: 'vid-1', title: 'CLICKBAIT 2' },
        { videoId: 'vid-2', title: 'CLICKBAIT 3' }
      ];

      const result = await provider.analyzeBatch({ videos, modelVersion: MODEL_VERSION });

      // Exactly one request
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Request body contains structured schema
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.contents[0].parts[0].text).toContain('vid-0');
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(body.generationConfig.responseSchema.properties.results.items.properties.stamp.enum).toHaveLength(6);

      expect(result.results).toHaveLength(3);
    });

    it('includes each video\'s signals in prompt', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          results: [{
            videoId: 'test-video',
            rewrittenTitle: 'Honest title',
            stamp: 'legitimate',
            stampExplanation: 'Explanation'
          }]
        }), { status: 200 })
      );

      const videos = [{
        videoId: 'test-video',
        title: 'Test Title',
        description: 'Test description',
        transcript: 'Sample transcript text',
        chapters: [{ startMs: 0, title: 'Intro' }]
      }];

      await provider.analyzeBatch({ videos, modelVersion: MODEL_VERSION });

      const promptText = (JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
        .contents[0].parts[0].text as string);
      expect(promptText).toContain('Test description');
      expect(promptText).toContain('Sample transcript text');
      expect(promptText).toContain('Intro');
    });
  });

  describe('stream parsing with strict validation', () => {
    it('parses streaming chunks and validates stamp tiers', async () => {
      // Simulate streaming response - chunks split mid-JSON
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"results":[{'));
          controller.enqueue(new TextEncoder().encode('"videoId":"abc","rewrittenTitle":"Good Title","stamp'));
          controller.enqueue(new TextEncoder().encode('":"legitimate","stampExplanation":"Nice"}]}'));
          controller.close();
        }
      });

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(stream, { status: 200 })
      );

      const result = await provider.analyzeBatch({
        videos: [{ videoId: 'abc', title: 'Bad Title' }],
        modelVersion: MODEL_VERSION
      });

      expect(result.results[0].videoId).toBe('abc');
      expect(result.results[0].rewrittenTitle).toBe('Good Title');
      expect(result.results[0].stamp).toBe(StampTier.LEGITIMATE);
    });

    it('falls back to UNSURE for malformed stamp in stream', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"results":[{'));
          controller.enqueue(new TextEncoder().encode('"videoId":"xyz","rewrittenTitle":"Ok","stamp":"INVALID-TIER","stampExplanation":"Hmm"}]}'));
          controller.close();
        }
      });

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(stream, { status: 200 })
      );

      const result = await provider.analyzeBatch({
        videos: [{ videoId: 'xyz', title: 'Clickbait' }],
        modelVersion: MODEL_VERSION
      });

      expect(result.results[0].stamp).toBe(StampTier.UNSURE);
      // Model provided its own explanation, which is preserved
      expect(result.results[0].stampExplanation).toBe('Hmm');
    });
  });

  describe('apiKey handling', () => {
    it('loads API key from browser storage', async () => {
      (globalThis as any).browser = {
        storage: {
          local: {
            get: vi.fn().mockResolvedValue({ geminiApiKey: 'stored-key-123' })
          }
        }
      }

      await provider.loadApiKey();

      // Private apiKey access via getter not exposed, but we can test the flow
      expect((globalThis as any).browser.storage.local.get).toHaveBeenCalledWith(['geminiApiKey']);
    });

    it('saves API key to browser storage', async () => {
      (globalThis as any).browser = {
        storage: {
          local: {
            set: vi.fn().mockResolvedValue(undefined)
          }
        }
      }

      await provider.saveApiKey('new-key-456');

      expect((globalThis as any).browser.storage.local.set).toHaveBeenCalledWith({ geminiApiKey: 'new-key-456' });
    });
  });
});

describe('IncrementalResultParser (chunk-by-chunk streaming)', () => {
  it('emits each video result as soon as its chunk completes', async () => {
    const emissionOrder: string[] = [];
    const fullJson = JSON.stringify({
      results: [
        { videoId: 's-1', rewrittenTitle: 'One', stamp: 'legitimate', stampExplanation: 'e1' },
        { videoId: 's-2', rewrittenTitle: 'Two', stamp: 'clickbait', stampExplanation: 'e2' },
        { videoId: 's-3', rewrittenTitle: 'Three', stamp: 'fake', stampExplanation: 'e3' }
      ]
    });

    // Split the JSON string into arbitrary chunks
    const chunks: string[] = [];
    for (let i = 0; i < fullJson.length; i += 30) {
      chunks.push(fullJson.slice(i, i + 30));
    }

    const provider2 = new GeminiProvider('test-api-key');
    const stream = new ReadableStream({
      start(controller) {
        chunks.forEach(c => controller.enqueue(new TextEncoder().encode(c)));
        controller.close();
      }
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const partialResults: string[] = [];
    const result = await provider2.analyzeBatch(
      { videos: [
        { videoId: 's-1', title: 'A' },
        { videoId: 's-2', title: 'B' },
        { videoId: 's-3', title: 'C' }
      ], modelVersion: MODEL_VERSION },
      (partial) => {
        partialResults.push(partial.videoId);
        emissionOrder.push(partial.videoId);
      }
    );

    // All three emitted incrementally, in stream order
    expect(partialResults).toEqual(['s-1', 's-2', 's-3']);
    expect(result.results).toHaveLength(3);
    expect(result.results.map(r => r.videoId)).toEqual(['s-1', 's-2', 's-3']);
  });

  it('does not emit anything until a full object is available', () => {
    const emitted: any[] = [];
    const parser = new IncrementalResultParser((r) => emitted.push(r));

    // Feed a half-complete object
    parser.append('{"results":[{"videoId":"half","rewritt');
    expect(emitted).toHaveLength(0);

    // Complete it
    parser.append('enTitle":"X","stamp":"fake","stampExplanation":"y"}]}');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].videoId).toBe('half');
    expect(parser.getResults()).toHaveLength(1);
  });
});
