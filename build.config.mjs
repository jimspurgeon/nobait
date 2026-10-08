import { build } from "esbuild";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const outdir = resolve(root, "dist", "firefox");

async function main() {
  const fs = await import("node:fs/promises");
  if (existsSync(outdir)) await fs.rm(outdir, { recursive: true, force: true });
  await fs.mkdir(outdir, { recursive: true });

  // Copy manifest and icons
  copyFileSync(
    resolve(root, "src", "manifest.json"),
    resolve(outdir, "manifest.json"),
  );
  const iconsSrc = resolve(root, "public", "icons");
  if (existsSync(iconsSrc)) {
    const destIcons = resolve(outdir, "icons");
    mkdirSync(destIcons, { recursive: true });
    for (const f of ["48.png", "96.png"]) {
      copyFileSync(resolve(iconsSrc, f), resolve(destIcons, f));
    }
  }

  // Build content and background
  await build({
    bundle: true,
    minify: process.argv.includes("--minify=true"),
    entryPoints: {
      content: resolve(root, "src", "content", "index.ts"),
      background: resolve(root, "src", "background", "index.ts"),
    },
    outdir,
    format: "iife",
    platform: "browser",
    splitting: false,
  });

  console.log("Built dist/firefox/content.js and dist/firefox/background.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
