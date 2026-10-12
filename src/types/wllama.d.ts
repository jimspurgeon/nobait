/**
 * Structural shape of the vendored @wllama/wllama module.
 *
 * The real package ships uncompiled .ts sources that do not pass this
 * project's strict tsconfig; the build (scripts/build.mjs) instead bundles
 * the patched single-file ESM build (node_modules/.cache/nobait/wllama.js)
 * via an esbuild alias. tsconfig `paths` maps the specifier here so
 * type-checking never follows the package's source entry.
 * See src/ai/wasm.ts `WllamaLike` for the interface we actually rely on.
 */
export declare class Wllama {
  constructor(pathConfig?: unknown, wllamaConfig?: unknown);
  loadModelFromUrl(urls: string[], config?: unknown): Promise<void>;
  createChatCompletion(
    messages: Array<{ role: string; content: string }>,
    options?: unknown,
  ): Promise<string>;
  exit(): Promise<void>;
}
