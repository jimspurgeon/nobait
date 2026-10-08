import { describe, it, test, expect } from 'vitest';
import {
  parseStampTier,
  parseBatchItem,
  CLASSIFY_SYSTEM_PROMPT,
  buildBatchUserPrompt,
  parseBatchResponse,
  sanitize,
  toPromptVideo,
  extractJsonArray,
} from '../../ai/classify';
import { StampTier } from '../../stamps/types';
import type { VideoSignal } from '../../content/signals';

describe('classify - strict parsing', () => {
  describe('parseStampTier', () => {
    it.each([
      ['legitimate', StampTier.LEGITIMATE],
      ['exaggerated', StampTier.EXAGGERATED],
      ['misleading', StampTier.MISLEADING],
      ['clickbait', StampTier.CLICKBAIT],
      ['fake', StampTier.FAKE],
      ['unsure', StampTier.UNSURE],
      ['LEGITIMATE', StampTier.LEGITIMATE],
      [' Legitimate ', StampTier.LEGITIMATE],
    ])('parses valid tier "%s" → %s', (input, expected) => {
      const result = parseStampTier(input);
      expect(result.tier).toBe(expected);
      expect(result.explanation).toBeUndefined();
    });

    it.each([
      ['invalid'],
      [''],
      [null],
      [undefined],
      [123],
      ['LEGIT'],
      ['click-bait'],
    ] as const)('falls back to UNSURE for invalid input %s', (input) => {
      const result = parseStampTier(input);
      expect(result.tier).toBe(StampTier.UNSURE);
      expect(result.explanation).toBeDefined();
    });
  });

  describe('parseBatchItem', () => {
    it('parses a valid batch item', () => {
      const raw = {
        videoId: 'abc123',
        rewrittenTitle: 'Actual Title Here',
        stamp: 'legitimate',
        stampExplanation: 'Accurate and honest framing'
      };

      const result = parseBatchItem(raw);
      expect(result).toEqual({
        videoId: 'abc123',
        rewrittenTitle: 'Actual Title Here',
        stamp: StampTier.LEGITIMATE,
        stampExplanation: 'Accurate and honest framing'
      });
    });

    it('defaults to UNSURE for malformed stamp', () => {
      const raw = {
        videoId: 'abc123',
        rewrittenTitle: 'Actual Title Here',
        stamp: 'not-a-valid-tier',
        stampExplanation: 'Some explanation'
      };

      const result = parseBatchItem(raw);
      expect(result?.stamp).toBe(StampTier.UNSURE);
      expect(result?.stampExplanation).toBe('Some explanation');
    });

    it('falls back to generated explanation when stampExplanation missing', () => {
      const result = parseBatchItem({
        videoId: 'abc124',
        rewrittenTitle: 'Actual Title Here',
        stamp: 'garbage'
      });
      expect(result?.stamp).toBe(StampTier.UNSURE);
      expect(result?.stampExplanation).toContain('Unknown stamp');
    });

    it('returns null for missing videoId', () => {
      const result = parseBatchItem({
        videoId: '',
        rewrittenTitle: 'Title',
        stamp: 'legitimate',
        stampExplanation: 'Explain'
      });
      expect(result).toBeNull();
    });

    it('returns null for non-object input', () => {
      expect(parseBatchItem(null)).toBeNull();
      expect(parseBatchItem('string')).toBeNull();
      expect(parseBatchItem(123)).toBeNull();
    });
  });
});

/**
 * Tests for the shared classify module (prompt building + strict parsing).
 * Verifies:
 *   - sanitize() truncates and normalizes input without mutating;
 *   - toPromptVideo() drops undefined fields;
 *   - parseBatchResponse() yields one verdict per input even on garbage;
 *   - malformed JSON, missing tiers, or unknown tiers → UNSURE fallback.
 */


describe("sanitize()", () => {
  test("collapses control chars and newlines to spaces", () => {
    expect(sanitize("foo\tbar\nbaz\n\nqux")).toBe("foo bar baz qux");
  });

  test("truncates hard and appends ellipsis", () => {
    const long = "x".repeat(1500);
    const out = sanitize(long, 100);
    expect(out.length).toBe(100);
    expect(out.endsWith("…")).toBe(true);
  });

  test("does NOT mutate the original string", () => {
    const original = "\n\n  hello   world  \n";
    sanitize(original);
    expect(original).toBe("\n\n  hello   world  \n");
  });
});

describe("toPromptVideo()", () => {
  test("includes only defined fields", () => {
    const vid: VideoSignal = {
      videoId: "dQw4w9WgXcQ",
      title: "Rickroll forever",
      description: undefined,
    };
    const out = toPromptVideo(vid);
    expect(Object.keys(out)).toEqual(["id", "title"]);
  });

  test("sanitizes long fields", () => {
    const vid: VideoSignal = {
      videoId: "abc123",
      title: "Short",
      description: "y".repeat(2000),
    };
    const out = toPromptVideo(vid);
    expect(out.description!.length).toBeLessThan(1500); // MAX_FIELD_CHARS default
  });
});

describe("extractJsonArray()", () => {
  test("extracts plain JSON arrays", () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  test("strips markdown fences", () => {
    expect(extractJsonArray("```json\n[{\"a\":1}]\n```")).toEqual([{ a: 1 }]);
  });

  test("returns null when no array exists", () => {
    expect(extractJsonArray("not json")).toBeNull();
    expect(extractJsonArray('{"a":1}')).toBeNull();
  });
});

describe("parseBatchResponse() — happy path", () => {
  const batch: VideoSignal[] = [
    { videoId: "vid1", title: "Clickbait title" },
    { videoId: "vid2", title: "Another title" },
  ];

  const goodJson = `[
    {"id":"vid1","title":"Honest title 1","tier":"legitimate","reason":"matches content"},
    {"id":"vid2","title":"Honest title 2","tier":"exaggerated","reason":"overstates"}
  ]`;

  test("yields results in input order", () => {
    const results = parseBatchResponse(goodJson, batch);
    expect(results.map((r) => r.videoId)).toEqual(["vid1", "vid2"]);
  });

  test("preserves rewritten titles and stamps", () => {
    const results = parseBatchResponse(goodJson, batch);
    expect(results[0]!.rewrittenTitle).toBe("Honest title 1");
    expect(results[0]!.stamp).toBe(StampTier.LEGITIMATE);
  });
});

describe("parseBatchResponse() — malformed output → UNSURE fallback", () => {
  const batch: VideoSignal[] = [{ videoId: "x", title: "T" }];

  test("unknown tier → UNSURE", () => {
    const results = parseBatchResponse(
      '[{"id":"x","title":"R","tier":"bad_tier","reason":"because"}]',
      batch,
    );
    expect(results[0]!.stamp).toBe(StampTier.UNSURE);
    expect(results[0]!.rewrittenTitle).toBe("T"); // original passthrough
  });

  test("missing reason → UNSURE", () => {
    const results = parseBatchResponse(
      '[{"id":"x","title":"R","tier":"legitimate"}]',
      batch,
    );
    expect(results[0]!.stamp).toBe(StampTier.UNSURE);
  });

  test("empty title → UNSURE", () => {
    const results = parseBatchResponse(
      '[{"id":"x","title":"","tier":"legitimate","reason":"x"}]',
      batch,
    );
    expect(results[0]!.stamp).toBe(StampTier.UNSURE);
  });

  test("garbage wrapped in array → UNSURE", () => {
    const results = parseBatchResponse(
      '[{"not_valid":true},{"also":false}]',
      batch,
    );
    expect(results[0]!.stamp).toBe(StampTier.UNSURE);
  });

  test("markdown fences + nonsense → UNSURE", () => {
    const results = parseBatchResponse(
      '```json\nthis is not json at all\n```',
      batch,
    );
    expect(results[0]!.stamp).toBe(StampTier.UNSURE);
  });
});

describe("parseBatchResponse() — partial success", () => {
  test("some valid + some invalid → fill gaps with UNSURE", () => {
    const batch: VideoSignal[] = [
      { videoId: "a", title: "A" },
      { videoId: "b", title: "B" },
      { videoId: "c", title: "C" },
    ];
    const partialJson = `[
      {"id":"a","title":"A_fixed","tier":"legitimate","reason":"good"},
      {"id":"b","title":"BAD_TIER_TIT","tier":"bogus","reason":"x"},
      {"id":"c","title":"C_fixed","tier":"fake","reason":"debunked"}
    ]`;
    const results = parseBatchResponse(partialJson, batch);
    expect(results.length).toBe(3);
    expect(results[0]!.stamp).toBe(StampTier.LEGITIMATE);
    expect(results[1]!.stamp).toBe(StampTier.UNSURE); // bogus tier
    expect(results[2]!.stamp).toBe(StampTier.FAKE);
  });
});

describe("CLASSIFY_SYSTEM_PROMPT", () => {
  test("contains the six tiers", () => {
    const tiers = Object.values(StampTier);
    for (const tier of tiers) {
      expect(CLASSIFY_SYSTEM_PROMPT).toContain(tier);
    }
  });

  test("states the ground rule about popularity", () => {
    expect(CLASSIFY_SYSTEM_PROMPT.toLowerCase()).toMatch(/punish.*popular/i);
  });
});

describe("buildBatchUserPrompt()", () => {
  test("produces compact JSON", () => {
    const vid: VideoSignal = {
      videoId: "test123",
      title: "Test title",
      channel: "Test Channel",
    };
    const out = buildBatchUserPrompt([vid]);
    expect(out).toContain('"id":"test123"');
    expect(out).toContain('"channel":"Test Channel"');
  });

  test("omits undefined fields", () => {
    const vid: VideoSignal = {
      videoId: "xyz",
      title: "Y",
      transcript: undefined,
    };
    const out = buildBatchUserPrompt([vid]);
    expect(out).not.toContain("transcript");
  });
});
