import { defineConfig } from "vite";
import { resolve } from "path";
import {
  cpSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const target = process.env.VITE_TARGET || "firefox";

export default defineConfig(({ mode }) => ({
  build: {
    // Firefox-first: MV3 content scripts target modern Gecko (ES2022).
    target: "firefox115",
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
        content: resolve(__dirname, "src/content/index.ts"),
        options: resolve(__dirname, "src/options/index.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].[hash].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
    sourcemap: mode === "development",
    minify: mode === "production",
    outDir: `dist/${target}`,
    emptyOutDir: true,
    cssCodeSplit: true,
  },
  // src/manifest.json is canonical — place it at the dist root (proper
  // Rollup plugin hook, fires after the bundle is written).
  plugins: [
    {
      name: "copy-extension-assets",
      closeBundle() {
        const dist = resolve(__dirname, `dist/${target}`);
        cpSync(
          resolve(__dirname, "src/manifest.json"),
          resolve(dist, "manifest.json"),
        );
        cpSync(
          resolve(__dirname, "src/styles/base.css"),
          resolve(dist, "content.css"),
        );
        // Vite emits the options page under src/options/index.html (mirroring
        // its source path); the manifest expects assets/options.html.
        const emitted = resolve(dist, "src/options/index.html");
        const wanted = resolve(dist, "assets/options.html");
        if (existsSync(emitted)) {
          renameSync(emitted, wanted);
          rmSync(resolve(dist, "src"), { recursive: true, force: true });
          // Rewrite the absolute /options.js script ref to a relative path.
          const html = readFileSync(wanted, "utf8").replace(
            'src="/options.js"',
            'src="../options.js"',
          );
          writeFileSync(wanted, html);
        }
      },
    },
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5175,
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
  },
}));
