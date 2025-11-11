import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import loggingPlugin from "./eslint-plugin-logging/index.js";

/**
 * ESLint Configuration for AI Studio (ESLint 9 Flat Config)
 *
 * LOGGING ENFORCEMENT:
 * - NO console.log/error/warn in server code (actions/, app/api/)
 * - Must use logger from @/lib/logger
 * - All server actions must generate requestId
 * - All async functions must have proper error handling
 *
 * Custom rules implemented in ./eslint-plugin-logging/index.js:
 * - no-console-in-server: Prevents console usage in server code
 * - require-request-id: Ensures request ID generation
 * - require-timer: Ensures performance timing
 * - require-logger-in-server-actions: Enforces logger usage
 * - no-generic-error-messages: Prevents "DB error" type messages
 * - use-error-factories: Encourages ErrorFactories over plain Error
 */

export default [
  // Ignore build outputs and generated files
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "dist/**",
      "node_modules/**",
      "next-env.d.ts",
      "**/*.config.js",
      "**/*.config.mjs",
      "**/*.config.ts",
      ".jest/**",
      "jest.*.js",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      ".eslintrc.custom.js",
      "eslint-plugin-logging/**",
    ],
  },

  // Base ESLint recommended rules
  js.configs.recommended,

  // TypeScript configuration
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
  },

  // React configuration
  {
    files: ["**/*.jsx", "**/*.tsx"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs["jsx-runtime"].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      "react/prop-types": "off", // Using TypeScript for prop validation
      "react/react-in-jsx-scope": "off", // Not needed in Next.js
    },
  },

  // Add custom logging plugin
  {
    plugins: {
      logging: loggingPlugin,
    },
  },

  // LOGGING ENFORCEMENT RULES
  // Rule 1: Disallow all console.* calls by default
  {
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Rule 2: Stricter rules for server actions and API routes
  {
    files: [
      "actions/**/*.ts",
      "actions/**/*.tsx",
      "app/api/**/*.ts",
      "app/api/**/*.tsx",
    ],
    rules: {
      "no-console": "error",
      "logging/no-console-in-server": "error",
      "logging/require-request-id": "error",
      "logging/require-timer": "error",
      "logging/require-logger-in-server-actions": "error",
      "logging/no-generic-error-messages": "error",
      "logging/use-error-factories": "warn",
    },
  },

  // Rule 3: Allow console.error ONLY in client components/hooks
  {
    files: [
      "components/**/*.tsx",
      "components/**/*.ts",
      "lib/hooks/**/*.ts",
    ],
    rules: {
      "no-console": [
        "error",
        { allow: ["error"] },
      ],
    },
  },

  // Rule 4: Special exceptions for Edge Runtime compatibility
  {
    files: [
      "lib/env-validation.ts",
      "middleware.ts",
    ],
    rules: {
      "no-console": "off",
    },
  },
];
