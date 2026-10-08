import { defineConfig } from "vite";

export default defineConfig({
  // Firefox-first: MV3 content scripts target modern Gecko (ES2022, no legacy).
  build: {
    target: "firefox115",
    outDir: "dist/firefox",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        content: new URL("./src/content/index.ts", import.meta.url).pathname,
        demo: new URL("./demo/index.html", import.meta.url).pathname,
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  server: {
    port: 5175,
  },
});
