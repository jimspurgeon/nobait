/**
 * Content-script settings: thin re-export of the unified settings module
 * (`src/settings/index.ts`) plus the legacy `loadSettings` alias kept for
 * importer compatibility.
 *
 * Live application: subscribe via `onSettingsChanged` — the underlying
 * `browser.storage.onChanged` listener fires for updates saved by the
 * options page without a page reload.
 */

export * from "../settings/index";

import { getSettings, type Settings } from "../settings/index";

/**
 * Load the current settings (alias of {@link getSettings}).
 * Retained for the pre-P7 call sites in `src/content/index.ts`.
 */
export function loadSettings(): Promise<Settings> {
  return getSettings();
}
