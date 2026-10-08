import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error"
    }
  },
  {
    files: ["bench/**", "apps/gateway/src/main.ts"],
    rules: { "no-console": "off" }
  },
  {
    // k6 scripts run in k6's runtime, which provides `__ENV`; they are not Node modules.
    files: ["deploy/load/**/*.js"],
    languageOptions: { globals: { __ENV: "readonly" } }
  }
);
