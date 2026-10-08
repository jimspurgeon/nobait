/**
 * Typed accessor for fact-check API key and settings.
 *
 * Uses browser.storage.local (encrypted at rest by the browser).
 * Absent key disables the layer entirely with a debug log — the layer is
 * a strict no-op then, never an error.
 */

const SETTINGS_KEY = 'nobait:factcheck-settings';

export interface FactCheckSettings {
  /** Google Fact Check Tools API key. */
  apiKey?: string | null;

  /** Whether the lookup layer is enabled. */
  enabled: boolean;

  /** Hard timeout for lookups in milliseconds (default 400ms). */
  timeoutMs: number;
}

export const DEFAULT_SETTINGS: Readonly<FactCheckSettings> = {
  apiKey: null,
  enabled: true,
  timeoutMs: 400,
};

/**
 * Resolve the WebExtensions API namespace portably (Firefox `browser`,
 * Chrome `chrome`), tolerating absence (unit tests).
 */
function browserAPI(): {
  storage?: { local?: { get?: (k: string) => Promise<Record<string, unknown>>; set?: (o: Record<string, unknown>) => Promise<void> } };
} | undefined {
  const g = globalThis as Record<string, unknown>;
  return (g['browser'] ?? g['chrome']) as ReturnType<typeof browserAPI>;
}

/**
 * Read fact-check settings from storage.
 */
export async function readSettings(): Promise<FactCheckSettings> {
  try {
    const api = browserAPI();
    const area = api?.storage?.local;
    if (typeof area?.get !== 'function') return { ...DEFAULT_SETTINGS };

    const bag = (await area.get(SETTINGS_KEY)) ?? {};
    const raw = (bag as Record<string, unknown>)[SETTINGS_KEY];
    if (raw == null || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };

    const r = raw as Record<string, unknown>;
    return {
      apiKey: typeof r['apiKey'] === 'string' ? r['apiKey'] : DEFAULT_SETTINGS.apiKey,
      enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : DEFAULT_SETTINGS.enabled,
      timeoutMs: typeof r['timeoutMs'] === 'number' && Number.isFinite(r['timeoutMs']) && r['timeoutMs'] > 0
        ? r['timeoutMs']
        : DEFAULT_SETTINGS.timeoutMs,
    };
  } catch (err) {
    console.warn('[nobait/factcheck] Failed to read settings:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Write updated settings to storage.
 */
export async function writeSettings(update: Partial<FactCheckSettings>): Promise<void> {
  try {
    const api = browserAPI();
    const area = api?.storage?.local;
    if (typeof area?.set !== 'function') return;

    const merged = { ...(await readSettings()), ...update };
    await area.set({ [SETTINGS_KEY]: merged });
  } catch (err) {
    console.warn('[nobait/factcheck] Failed to write settings:', err);
  }
}

/**
 * Check whether the fact-check layer is enabled AND has an API key.
 */
export async function isLayerAvailable(): Promise<boolean> {
  const { enabled, apiKey } = await readSettings();
  if (!enabled) return false;
  if (!apiKey || apiKey.trim() === '') {
    console.debug('[nobait/factcheck] Layer disabled: no API key configured');
    return false;
  }
  return true;
}

/**
 * Get the API key (trimmed), or null when absent/blank.
 */
export async function getApiKey(): Promise<string | null> {
  const { apiKey } = await readSettings();
  return apiKey && apiKey.trim() !== '' ? apiKey.trim() : null;
}

/**
 * Get the configured hard timeout in milliseconds.
 */
export async function getTimeoutMs(): Promise<number> {
  const { timeoutMs } = await readSettings();
  return timeoutMs;
}
