import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "build/**",
      "coverage/**",
      "dist/**",
      "dist-electron/**",
      "node_modules/**",
      "release/**"
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      // A dropped promise in the main process silently loses refresh, cache, and
      // credential commits, so both of these stay errors rather than warnings.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          // Async React event handlers are idiomatic and every handler in this
          // codebase routes its own failures to setError/setToast. Promise-typed
          // *arguments* stay checked.
          checksVoidReturn: { arguments: false, attributes: false }
        }
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true }
      ]
    }
  },

  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Components are plain functions here; the compiler plugin's exhaustive
      // checks are covered by typecheck and are not part of this rule set.
      "react-hooks/react-compiler": "off"
    }
  },

  {
    files: ["tests/**/*.ts"],
    rules: {
      // Tests deliberately build partial or malformed payloads to pin the
      // runtime contracts that guard the real IPC boundary.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      // `expect(fake.adapter.list)` reads a method off a stub object without
      // calling it; the rule has no useful signal for vitest mocks.
      "@typescript-eslint/unbound-method": "off"
    }
  },

  {
    files: ["**/*.{js,mjs,cjs}", "*.config.ts", "scripts/**"],
    extends: [tseslint.configs.disableTypeChecked]
  }
);
