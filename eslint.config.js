import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/", ".nobait/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Node scripts: build config and icon generator.
    files: ["build.config.mjs", "scripts/**"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
      },
    },
  },
  {
    // Content/background/options scripts run in extension contexts.
    files: [
      "src/content/**",
      "src/background/**",
      "src/options/**",
      "src/ai/**",
    ],
    languageOptions: {
      globals: {
        browser: "readonly",
        console: "readonly",
      },
    },
  },
  prettier,
);
