import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/", ".nobait/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Legacy-typed code: non-null assertions and `any` are pervasive in the
    // JS interop layers (YouTube DOM, InnerTube responses). Tracked for
    // cleanup; typecheck still guards type safety.
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      // Underscore-prefixed params are intentional ("present but unused") in
      // test mocks and event handlers.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
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
