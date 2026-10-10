/**
 * Firefox MV3 build — esbuild-based, single-file IIFE outputs.
 *
 * Why not Vite/Rollup: Firefox content scripts are CLASSIC scripts.
 * Rollup's multi-entry code-splitting emits ES module `import` statements,
 * which fail to parse as classic scripts — the entire content script
 * silently never runs. Extension entrypoints must each be one
 * self-contained IIFE with no imports between files.
 *
 * wllama vendoring: the stock @wllama/wllama ESM bundle spawns its workers
 * from blob: URLs, which Firefox MV3 CSP forbids in extension pages. The
 * build writes a patched copy (createWorker → packaged static worker files,
 * emitted by scripts/gen-wllama-worker.mjs) to node_modules/.cache and
 * aliases "@wllama/wllama" to it, so src code imports normally.
 */
import { build } from "esbuild";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { emitWllamaWorkers } from "./gen-wllama-worker.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const target = process.env.VITE_TARGET || "firefox";
const dist = resolve(process.cwd(), "dist", target);

const DEV = process.env.NODE_ENV === "development";

const STOCK_WLLAMA = resolve(
  __dirname,
  "../node_modules/@wllama/wllama/esm/index.js",
);
const VENDOR_DIR = resolve(__dirname, "../node_modules/.cache/nobait");
const VENDOR_OUT = join(VENDOR_DIR, "wllama.js");

/**
 * Vendor the wllama ESM bundle with `createWorker` patched to return
 * packaged static worker files instead of blob: URLs (Firefox MV3 CSP
 * forbids blob: workers in extension pages — classic AND module types).
 *
 * Distinguishes wllama's two createWorker call sites:
 *  - the OPFS utils worker: its code equals the OPFS_UTILS_WORKER_CODE
 *    constant → opfs-worker.js
 *  - everything else: assembled inference worker code → ai-worker.js
 *
 * The rest of the stock bundle (including its export block) is untouched.
 */
function vendorWllama() {
  const src = readFileSync(STOCK_WLLAMA, "utf8");
  const needle = "var createWorker = (workerCode) => {";
  const start = src.indexOf(needle);
  if (start === -1) {
    throw new Error(
      "[build] createWorker not found in @wllama/wllama — " +
        "package format changed, vendoring patch needs an update",
    );
  }
  const end = src.indexOf("};", start);
  if (end === -1) throw new Error("[build] createWorker terminator not found");

  const patched = `
var createWorker = (workerCode) => {
  // nobait: packaged static workers — Firefox MV3 CSP forbids blob: workers.
  // The OPFS utils worker's source is the OPFS_UTILS_WORKER_CODE constant;
  // all other call sites pass the assembled inference worker code.
  const __nbGetURL = (p) => {
    const rt = (typeof browser !== "undefined" ? browser : chrome)?.runtime;
    if (rt?.getURL) return rt.getURL(p);
    return new URL("../" + p, self.location.href).href;
  };
  const url =
    typeof workerCode === "string" && workerCode === OPFS_UTILS_WORKER_CODE
      ? __nbGetURL("opfs-worker.js")
      : __nbGetURL("ai-worker.js");
  return new Worker(url, { type: "module" });
};`;

  const out = src.slice(0, start) + patched.trimEnd() + src.slice(end + 2);
  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(VENDOR_OUT, out);
}

vendorWllama();

/** Recursively copy static assets. */
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else cpSync(s, d);
  }
}

const shared = {
  bundle: true,
  format: "iife",
  target: "firefox115",
  sourcemap: DEV ? "linked" : false,
  minify: DEV ? false : true,
  legalComments: "none",
  logLevel: "info",
  alias: { "@wllama/wllama": VENDOR_OUT },
  define: { "process.env.NODE_ENV": JSON.stringify(DEV ? "development" : "production") },
};

// Clean output.
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. Three IIFE entrypoints (self-contained, no cross-chunk imports).
await build({
  ...shared,
  entryPoints: [resolve("src/content/index.ts")],
  outfile: resolve(dist, "content.js"),
});

await build({
  ...shared,
  entryPoints: [resolve("src/background/index.ts")],
  outfile: resolve(dist, "background.js"),
});

// 2. Options page: esbuild handles the TS entry; we write the HTML shell.
await build({
  ...shared,
  entryPoints: [resolve("src/options/index.ts")],
  outfile: resolve(dist, "assets/options.js"),
});

// 3. Static assets: manifest, icons, options html/css, content styles.
copyDir(resolve("public"), dist);
cpSync(resolve("src/manifest.json"), resolve(dist, "manifest.json"));
mkdirSync(resolve(dist, "assets"), { recursive: true });

// Options HTML: strip the module script, inject a classic script tag.
const fs = await import("node:fs/promises");
let optsHtml = await fs.readFile(resolve("src/options/index.html"), "utf8");
optsHtml = optsHtml
  .replace('<script type="module" src="./index.ts"></script>', "")
  .replace(
    /<\/body>/,
    '    <script src="./options.js"></script>\n  </body>',
  );
await fs.writeFile(resolve(dist, "assets/options.html"), optsHtml);
cpSync(resolve("src/options/styles.css"), resolve(dist, "assets/options.css"));
cpSync(resolve("src/styles/base.css"), resolve(dist, "content.css"));

// 4. Static wllama workers + wasm. Emitted only when the background bundle
//    actually pulled in the vendored wllama (marker: the patched
//    createWorker's "ai-worker.js" string survived minification).
if (readFileSync(resolve(dist, "background.js"), "utf8").includes("ai-worker.js")) {
  console.log("[build] wllama bundled — emitting static worker files");
  emitWllamaWorkers(dist);
}

console.log(`[build] wrote dist/${target}/ (IIFE, classic-script safe)`);
