import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "^../../src/": new URL("../../src/", import.meta.url).pathname,
    },
  },
});
