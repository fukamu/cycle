import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "coverage",
      "playwright-report",
      "test-results",
      ".tools",
      ".npm-cache",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-globals": [
        "error",
        {
          name: "alert",
          message: "Use an in-app status, error, or dialog component instead.",
        },
        {
          name: "confirm",
          message: "Use the shared in-app confirmation dialog instead.",
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "window",
          property: "alert",
          message: "Use an in-app status, error, or dialog component instead.",
        },
        {
          object: "window",
          property: "confirm",
          message: "Use the shared in-app confirmation dialog instead.",
        },
        {
          object: "globalThis",
          property: "alert",
          message: "Use an in-app status, error, or dialog component instead.",
        },
        {
          object: "globalThis",
          property: "confirm",
          message: "Use the shared in-app confirmation dialog instead.",
        },
      ],
    },
  },
);
