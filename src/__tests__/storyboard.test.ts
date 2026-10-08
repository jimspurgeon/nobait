import { describe, test, expect } from 'vitest';
import { parseSpecString, parseStoryboardSpec, selectLevel, buildSheetUrl } from '../thumbnail/storyboard';

// Valid multi-level spec (realistic): URL | desc0 | desc1 | ...
// Descriptor layout: frameW#frameH#intervalMs#cols#rows#<?>#<?>#label#sigh
const MULTI_LEVEL_SPEC =
  'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L$L$/$N$.jpg?sqp=x|48#27#10000#5#5#1#1#L0#sighL0|80#45#5000#5#5#1#1#L1#sighL1|160#90#5000#5#5#1#1#L2#sighL2';

describe('parseSpecString', () => {
  test('parses multi-level spec with duration', () => {
    const spec = parseSpecString(MULTI_LEVEL_SPEC, 300_000);
    expect(spec.levels).toHaveLength(3);
    const [l0, l1, l2] = spec.levels;
    expect(l0).toMatchObject({
      width: 48,
      height: 27,
      intervalMs: 10000,
      columns: 5,
      rows: 5,
      sigh: 'sighL0',
      framesPerSheet: 25,
    });
    expect(l1.width).toBe(80);
    expect(l2.level).toBe(2);
    expect(l0.totalFrames).toBe(30);
    expect(l1.totalFrames).toBe(60);
    expect(l2.totalFrames).toBe(60);
  });

  test('throws on garbage', () => {
    expect(() => parseSpecString('')).toThrow();
    expect(() => parseSpecString('foo')).toThrow();
  });

  test('non-http first field is rejected', () => {
    expect(() => parseSpecString('notaurl|80#45#5000#2#2#1#1#L0#sig')).toThrow();
  });

  test('single-level spec works', () => {
    const line = 'https://i.ytimg.com/sb/x/storyboard3_L$L$/$N$.jpg|80#45#5000#2#2#1#1#L0#sig';
    const spec = parseSpecString(line);
    expect(spec.levels.length).toBe(1);
    expect(spec.levels[0].totalFrames).toBe(4); // 2×2
  });
});

describe('buildSheetUrl', () => {
  test('substitutes $L$, $N$, $sigh$', () => {
    const line = 'https://i.ytimg.com/sb/x/storyboard3_L$L$/$N$.jpg?sigh=$sigh$|80#45#5000#2#2#1#1#L0#mysig';
    const spec = parseSpecString(line);
    const url = buildSheetUrl(spec.levels[0], 3);
    expect(url).toBe('https://i.ytimg.com/sb/x/storyboard3_L0/M3.jpg?sigh=mysig');
  });

  test('handles $M$ placeholder variant', () => {
    const line = 'https://i.ytimg.com/sb/x/storyboard3_L$L$/M$M$.jpg?sigh=$sigh$|80#45#5000#2#2#1#1#L0#s9';
    const spec = parseSpecString(line);
    expect(buildSheetUrl(spec.levels[0], 7)).toBe('https://i.ytimg.com/sb/x/storyboard3_L0/M7.jpg?sigh=s9');
  });
});

describe('parseStoryboardSpec normalization', () => {
  test('round-trips an already-normalized spec', () => {
    const line = 'https://i.ytimg.com/sb/x/storyboard3_L$L$/$N$.jpg?sigh=$sigh$|80#45#5000#2#2#1#1#L0#s1';
    const spec = parseSpecString(line, 60_000);
    const rt = parseStoryboardSpec(spec);
    expect(rt).not.toBeNull();
    expect(rt!.levels).toHaveLength(1);
    expect(rt!.levels[0].width).toBe(80);
    expect(rt!.levels[0].totalFrames).toBe(12); // 60s / 5s
  });

  test('parses a raw player_response object', () => {
    const playerResponse = {
      storyboards: {
        playerStoryboardSpecRenderer: {
          spec: 'https://i.ytimg.com/sb/x/storyboard3_L$L$/$N$.jpg?sigh=$sigh$|80#45#5000#2#2#1#1#L0#s1',
        },
      },
      videoDetails: { lengthSeconds: '62' },
    };
    const spec = parseStoryboardSpec(playerResponse);
    expect(spec).not.toBeNull();
    expect(spec!.levels[0].totalFrames).toBe(Math.ceil(62_000 / 5000));
  });

  test('returns null for junk input', () => {
    expect(parseStoryboardSpec(null)).toBeNull();
    expect(parseStoryboardSpec(42)).toBeNull();
    // Malformed URL (no valid levels) returns null
    expect(parseStoryboardSpec('notaurl|80#45#5000#2#2#1#1#L0#sig')).toBeNull();
    expect(parseStoryboardSpec({})).toBeNull();
  });
});

describe('selectLevel', () => {
  const makeSpec = () => {
    const line =
      'https://i.ytimg.com/sb/x/storyboard3_L$L$/$N$.jpg?sigh=$sigh$|48#27#10000#5#5#1#1#L0#s0|80#45#5000#5#5#1#1#L1#s1|160#90#5000#5#5#1#1#L2#s2|320#180#5000#5#5#1#1#L3#s3';
    return parseSpecString(line, 300_000);
  };

  test('chooses smallest level ≥ minWidth', () => {
    const spec = makeSpec();
    expect(selectLevel(spec, 100).width).toBe(160);
    expect(selectLevel(spec, 320).width).toBe(320);
  });

  test('falls back to largest when nothing is wide enough', () => {
    const spec = makeSpec();
    expect(selectLevel(spec, 9999).width).toBe(320);
  });
});
