/**
 * AI provider factory — placeholder for P3/P4. Selection order per AGENTS.md:
 * Chrome built-in AI → Gemini (BYO key) → Ollama → disabled with warning.
 */
import type { AIProvider } from "./types";

export function createProvider(): AIProvider | null {
  // TODO(P3): read config from browser.storage, instantiate backend.
  return null;
}
