import { describe, it, expect, vi } from 'vitest';
import { evaluateFactCheck } from './factcheck.js';
import { StampTier } from './factcheck-types.js';
import type { FactCheckDeps } from './factcheck.js';

const META_FAKE_LEAN = { title: 'Whatever the title', preliminaryStamp: 'fake' as const };

/** Settings fixture: enabled with key. */
const SETTINGS_ENABLED = { apiKey: 'test-key', enabled: true, timeoutMs: 50 };

/** Realistic claims:search body with false-rated reviews. */
const FALSE_BODY = {
  claims: [{
    text: 'Vaccines cause autism',
    claimReview: [
      { publisher: { name: 'Snopes' }, url: 'https://snopes.com/x', textualRating: 'False', reviewDate: '2021-01-01T00:00:00Z' },
      { publisher: { name: 'Politifact' }, url: 'https://politifact.com/y', textualRating: 'Pants on Fire' },
    ],
  }],
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function makeFetch(responses: unknown[] = [], opts: { delayMs?: number } = {}): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (opts.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('evaluateFactCheck — gating', () => {
  it('skips (disabled) when settings.enabled is false — no fetch', async () => {
    const { fetchImpl, calls } = makeFetch();
    const deps: FactCheckDeps = {
      fetchImpl,
      readSettingsImpl: async () => ({ apiKey: 'key', enabled: false, timeoutMs: 50 }),
    };
    const ev = await evaluateFactCheck('v1', META_FAKE_LEAN, StampTier.EXAGGERATED, deps);
    expect(ev.status).toBe('skipped');
    expect(ev.skipReason).toBe('disabled');
    expect(ev.result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('skips (no-api-key) when key missing — no fetch', async () => {
    const { fetchImpl, calls } = makeFetch();
    const deps: FactCheckDeps = {
      fetchImpl,
      readSettingsImpl: async () => ({ apiKey: '', enabled: true, timeoutMs: 50 }),
    };
    const ev = await evaluateFactCheck('v1', META_FAKE_LEAN, StampTier.EXAGGERATED, deps);
    expect(ev.status).toBe('skipped');
    expect(ev.skipReason).toBe('no-api-key');
    expect(calls).toHaveLength(0);
  });

  it('logs a debug message when the key is absent', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const deps: FactCheckDeps = {
        fetchImpl: makeFetch().fetchImpl,
        readSettingsImpl: async () => ({ apiKey: '', enabled: true, timeoutMs: 50 }),
      };
      await evaluateFactCheck('v1', META_FAKE_LEAN, StampTier.EXAGGERATED, deps);
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('no API key'));
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('skips (no-trigger) when heuristic misses — no fetch', async () => {
    const { fetchImpl, calls } = makeFetch();
    const deps: FactCheckDeps = {
      fetchImpl,
      readSettingsImpl: async () => SETTINGS_ENABLED,
    };
    const ev = await evaluateFactCheck('v1', { title: 'Minecraft speedrun highlights' }, StampTier.LEGITIMATE, deps);
    expect(ev.status).toBe('skipped');
    expect(ev.skipReason).toBe('no-trigger');
    expect(calls).toHaveLength(0);
  });

  it('fires the lookup with API key in URL when triggered', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse(FALSE_BODY)]);
    const deps: FactCheckDeps = {
      fetchImpl,
      readSettingsImpl: async () => SETTINGS_ENABLED,
    };
    const ev = await evaluateFactCheck('v1', META_FAKE_LEAN, StampTier.EXAGGERATED, deps);
    expect(ev.status).toBe('corroborated');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('query=');
    expect(calls[0]).toContain('key=test-key');
    expect(calls[0]).toContain('factchecktools.googleapis.com');
  });
});

describe('evaluateFactCheck — corroboration', () => {
  it('fast fetch with false claims strengthens to FAKE', async () => {
    const { fetchImpl } = makeFetch([jsonResponse(FALSE_BODY)]);
    const deps: FactCheckDeps = { fetchImpl, readSettingsImpl: async () => SETTINGS_ENABLED };
    const ev = await evaluateFactCheck('v1', META_FAKE_LEAN, StampTier.EXAGGERATED, deps);
    expect(ev.status).toBe('corroborated');
    expect(ev.strengthened).toBe(true);
    expect(ev.result?.stamp).toBe(StampTier.FAKE);
    expect(ev.result?.sourceLines).toHaveLength(2);
  });

  it('no-results body returns no-change outcome', async () => {
    const { fetchImpl } = makeFetch([jsonResponse({})]);
    const deps: FactCheckDeps = { fetchImpl, readSettingsImpl: async () => SETTINGS_ENABLED };
    const ev = await evaluateFactCheck('v1', META_FAKE_LEAN, StampTier.EXAGGERATED, deps);
    expect(ev.status).toBe('no-results');
    expect(ev.strengthened).toBe(false);
    expect(ev.result?.stamp).toBe(StampTier.EXAGGERATED);
  });

  it('non-OK HTTP response resolves as no-results (never throws)', async () => {
    const { fetchImpl } = makeFetch([new Response('{}', { status: 500 })]);
    const deps: FactCheckDeps = { fetchImpl, readSettingsImpl: async () => SETTINGS_ENABLED };
    const ev = await evaluateFactCheck('v1', META_FAKE_LEAN, StampTier.EXAGGERATED, deps);
    expect(ev.status).toBe('no-results');
  });

  it('network error resolves as error status (never throws)', async () => {
    const { fetchImpl } = makeFetch([new TypeError('network down')]);
    const deps: FactCheckDeps = { fetchImpl, readSettingsImpl: async () => SETTINGS_ENABLED };
    const ev = await evaluateFactCheck('v1', META_FAKE_LEAN, StampTier.EXAGGERATED, deps);
    expect(ev.status).toBe('error');
    expect(ev.result).toBeNull();
  });

  it('malformed JSON resolves as no-results', async () => {
    const badJson = {
      json: () => Promise.reject(new SyntaxError('bad json')),
      ok: true,
    } as unknown as Response;
    const { fetchImpl } = makeFetch([badJson]);
    const deps: FactCheckDeps = { fetchImpl, readSettingsImpl: async () => SETTINGS_ENABLED };
    const ev = await evaluateFactCheck('v1', META_FAKE_LEAN, StampTier.EXAGGERATED, deps);
    expect(ev.status).toBe('no-results');
  });
});

describe('evaluateFactCheck — racing timeout', () => {
  it('slow fetch is dropped silently as timeout, never gating the caller', async () => {
    // Fetch would take 1000ms; timeout is 50ms. The evaluation must settle
    // in well under the fetch duration.
    const { fetchImpl } = makeFetch([jsonResponse(FALSE_BODY)], { delayMs: 1000 });
    const deps: FactCheckDeps = { fetchImpl, readSettingsImpl: async () => SETTINGS_ENABLED };
    const start = Date.now();
    const ev = await evaluateFactCheck('v1', META_FAKE_LEAN, StampTier.EXAGGERATED, deps);
    const elapsed = Date.now() - start;
    expect(ev.status).toBe('timeout');
    expect(ev.result).toBeNull();
    expect(ev.strengthened).toBe(false);
    // Prove the race: settled far faster than the 1000ms fetch.
    expect(elapsed).toBeLessThan(500);
  });

  it('aborts the underlying fetch via AbortController', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      await new Promise((_resolve, reject) => {
        const t = setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 2000);
        observedSignal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    const deps: FactCheckDeps = { fetchImpl, readSettingsImpl: async () => SETTINGS_ENABLED };
    const ev = await evaluateFactCheck('v1', META_FAKE_LEAN, StampTier.EXAGGERATED, deps);
    expect(ev.status).toBe('timeout');
    expect(observedSignal?.aborted).toBe(true);
  });

  it('late-arriving result goes to onLateResult hook instead of the swap path', async () => {
    const onLateResult = vi.fn();
    // Race trick: fetch succeeds quickly but AFTER the timeout fires.
    // Use a tiny timeout (1ms) and a modest delay (50ms).
    const { fetchImpl } = makeFetch([jsonResponse(FALSE_BODY)], { delayMs: 50 });
    const deps: FactCheckDeps = {
      fetchImpl,
      readSettingsImpl: async () => ({ ...SETTINGS_ENABLED, timeoutMs: 5 }),
      onLateResult,
    };
    const ev = await evaluateFactCheck('v1', META_FAKE_LEAN, StampTier.EXAGGERATED, deps);
    expect(ev.status).toBe('timeout');
    expect(ev.result).toBeNull();

    // Give the late fetch time to resolve and call the hook.
    await new Promise((r) => setTimeout(r, 150));
    expect(onLateResult).toHaveBeenCalledTimes(1);
    const [videoId, outcome] = onLateResult.mock.calls[0]!;
    expect(videoId).toBe('v1');
    expect(outcome.stamp).toBe(StampTier.FAKE); // composed for tooltip refresh
  });
});
