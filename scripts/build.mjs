/**
 * Firefox MV3 build — esbuild-based, single-file IIFE outputs.
 *
 * Why not Vite/Rollup: Firefox content scripts are CLASSIC scripts.
 * Rollup's multi-entry code-splitting emits ES module `import` statements,
 * which fail to parse as classic scripts — the entire content script
 * silently never runs. Extension entrypoints must each be one
 * self-contained IIFE with no imports between files.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const target = process.env.VITE_TARGET || "firefox";
const dist = resolve(process.cwd(), "dist", target);

const DEV = process.env.NODE_ENV === "development";

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

console.log(`[build] wrote dist/${target}/ (IIFE, classic-script safe)`);
