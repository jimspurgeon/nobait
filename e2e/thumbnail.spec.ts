import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * P2 thumbnail E2E — fully mocked, no live network.
 *
 * Strategy: serve a fixture "YouTube grid" page at https://www.youtube.com/
 * via route interception, mock the InnerTube player endpoint and the sprite
 * sheet images, then inject the built content script and assert the
 * thumbnail swap behavior.
 */

// ------------------------------------------------------------- fixtures ----

const GRID_SIZE = 60;
const FRAME_W = 100;
const FRAME_H = 57;

const vid = (i: number): string => `v${String(i).padStart(10, '0')}xx`;

function gridPageHtml(): string {
  const cards = Array.from({ length: GRID_SIZE }, (_, i) => `
    <ytd-rich-item-renderer>
      <ytd-thumbnail>
        <a id="thumbnail" class="yt-simple-endpoint" href="/watch?v=${vid(i)}">
          <img id="img" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="" />
        </a>
      </ytd-thumbnail>
    </ytd-rich-item-renderer>`).join('\n');
  return `<!doctype html><html><body><div id="contents">${cards}</div></body></html>`;
}

/** PNG encoder (truecolor, no filtering) — generates sprite sheet images. */
import { deflateSync } from 'node:zlib';

function crc32(buf: Buffer): number {
  let table = (crc32 as any).t;
  if (!table) {
    table = (crc32 as any).t = new Int32Array(256).map((_: any, n: number) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
  }
  let crc = -1;
  for (const b of buf) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makeSpritePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array(height).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface Counters {
  player: number;
  sprites: number;
}

/** Wire up all routes and return mutable counters. */
async function mockYouTube(page: Page): Promise<Counters> {
  const counters: Counters = { player: 0, sprites: 0 };

  const cors = {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  };

  await page.route('**/*', async (route: Route) => {
    const url = new URL(route.request().url());

    // Grid page (main document).
    if (url.hostname === 'www.youtube.com' && url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: gridPageHtml(), headers: cors });
      return;
    }

    // InnerTube player endpoint → storyboard spec for the requested video.
    // The query key is the runtime-extracted stub ('TEST_KEY_NOT_SECRET').
    if (url.hostname === 'www.youtube.com' && url.pathname === '/youtubei/v1/player') {
      counters.player++;
      const body = (route.request().postData() ?? '') as string;
      const m = /"videoId":"([^"]+)"/.exec(body);
      const videoId = m?.[1] ?? 'unknown';
      const spec =
        `https://i.ytimg.com/sb/${videoId}/storyboard3_L$L$/$N$.jpg?sigh=$sigh$` +
        `|${FRAME_W}#${FRAME_H}#4000#3#3#1#1#L0#sig${videoId}`;
      await route.fulfill({
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify({
          videoDetails: { lengthSeconds: '240' }, // 4 min
          storyboards: { playerStoryboardSpecRenderer: { spec } },
        }),
      });
      return;
    }

    // Sprite sheets — 3×3 grid of FRAME_W×FRAME_H tiles.
    if (url.hostname === 'i.ytimg.com' && url.pathname.startsWith('/sb/')) {
      counters.sprites++;
      const hue = (counters.sprites * 37) % 255;
      const png = makeSpritePng(FRAME_W * 3, FRAME_H * 3, [hue, 255 - hue, (hue * 2) % 255]);
      await route.fulfill({
        contentType: 'image/jpeg',
        headers: cors,
        body: png,
      });
      return;
    }

    await route.continue().catch(() => route.fulfill({ status: 404, body: '' }));
  });

  return counters;
}

async function loadExtension(page: Page): Promise<void> {
  // The content script extracts the InnerTube API key from the page's own
  // ytcfg at runtime (no hardcoded key). Install a stub with a dummy,
  // non-secret value before injecting so the mocked player endpoint can
  // be reached. addInitScript covers page loads (incl. reload), and the
  // direct define() covers this already-loaded document.
  const stubYtcfg = (): void => {
    (window as unknown as { ytcfg: unknown }).ytcfg = {
      get: (k: string): string | undefined => (k === 'INNERTUBE_API_KEY' ? 'TEST_KEY_NOT_SECRET' : undefined),
    };
  };
  await page.addInitScript(stubYtcfg);
  await page.evaluate(stubYtcfg);
  await page.addScriptTag({ path: 'dist/firefox/content.js', type: 'module' });
}

// ---------------------------------------------------------------- tests ----

test.describe('Thumbnail Swap (P2)', () => {
  test('swaps all grid thumbnails to blob URLs, caches across reloads, stays smooth', async ({ page }) => {
    const counters = await mockYouTube(page);
    await page.goto('https://www.youtube.com/');

    await loadExtension(page);

    // AC #4: every card gets its <img> swapped to a blob URL.
    await page.waitForFunction(
      () => {
        const swapped = document.querySelectorAll('img[data-nobait-thumb="1"]');
        return swapped.length >= 60;
      },
      undefined,
      { timeout: 15_000 }
    );
    const blobCount = await page.$$eval('img[data-nobait-thumb="1"]', (imgs) =>
      imgs.filter((i) => i.getAttribute('src')?.startsWith('blob:')).length
    );
    expect(blobCount).toBe(60);

    // AC #1/#2/#3 plumbing: exactly one player call + one sprite per video.
    expect(counters.player).toBe(60);
    expect(counters.sprites).toBe(60);

    // AC #6: animation stays smooth — sample rAF deltas while fading.
    const maxGap = await page.evaluate(async () => {
      let prev = performance.now();
      let worst = 0;
      const samples: number[] = [];
      await new Promise<void>((resolve) => {
        const started = performance.now();
        const tick = (): void => {
          const now = performance.now();
          samples.push(now - prev);
          worst = Math.max(worst, now - prev);
          prev = now;
          if (now - started < 500) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      return worst;
    });
    // Generous CI threshold: no single frame should stall ~an order of
    // magnitude beyond the 16.7ms budget (shared-ticker design keeps the
    // main thread free).
    expect(maxGap).toBeLessThan(120);

    // AC #5: reload → everything served from IndexedDB, zero new fetches.
    await page.reload();
    await loadExtension(page);
    await page.waitForFunction(
      () => document.querySelectorAll('img[data-nobait-thumb="1"]').length >= 60,
      undefined,
      { timeout: 15_000 }
    );
    const playerAfter = counters.player;
    const spritesAfter = counters.sprites;
    await page.waitForTimeout(500); // allow any stray fetches to register
    expect(counters.player).toBe(playerAfter); // no new player calls
    expect(counters.sprites).toBe(spritesAfter); // no new sprite downloads
    const blobCount2 = await page.$$eval('img[data-nobait-thumb="1"]', (imgs) =>
      imgs.filter((i) => i.getAttribute('src')?.startsWith('blob:')).length
    );
    expect(blobCount2).toBe(60);
  });

  test('prefers-reduced-motion collapses the animation to an instant swap', async ({ page }) => {
    await mockYouTube(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('https://www.youtube.com/');
    await loadExtension(page);

    await page.waitForFunction(
      () => document.querySelectorAll('img[data-nobait-thumb="1"]').length >= 60,
      undefined,
      { timeout: 15_000 }
    );

    // No crossfade overlay canvases should ever be created.
    expect(await page.$$eval('canvas', (els) => els.length)).toBe(0);
    // And the swap is still a real blob URL.
    const blobCount = await page.$$eval('img[data-nobait-thumb="1"]', (imgs) =>
      imgs.filter((i) => i.getAttribute('src')?.startsWith('blob:')).length
    );
    expect(blobCount).toBe(60);
  });
});
