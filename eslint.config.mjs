import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import securityPlugin from "eslint-plugin-security";
import jsxA11yPlugin from "eslint-plugin-jsx-a11y";
import reactPerfPlugin from "eslint-plugin-react-perf";
import unicornPlugin from "eslint-plugin-unicorn";
import loggingPlugin from "./eslint-plugin-logging/index.js";

/**
 * ESLint Configuration for AI Studio (ESLint 9 Flat Config)
 * Phase 4: Enhanced Linting Rules (Issue #460)
 *
 * LOGGING ENFORCEMENT:
 * - NO console.log/error/warn in server code (actions/, app/api/)
 * - Must use logger from @/lib/logger
 * - All server actions must generate requestId
 * - All async functions must have proper error handling
 *
 * SECURITY (eslint-plugin-security):
 * - Detect unsafe regex, eval(), SQL injection patterns
 * - Prevent security vulnerabilities
 *
 * ACCESSIBILITY (eslint-plugin-jsx-a11y):
 * - WCAG compliance for public sector (school district)
 * - Accessible UI components for all students/staff
 *
 * PERFORMANCE (eslint-plugin-react-perf):
 * - Detect inefficient React patterns
 * - Prevent unnecessary re-renders
 *
 * CODE QUALITY (eslint-plugin-unicorn):
 * - Modern JavaScript/TypeScript best practices
 * - Consistent coding patterns
 *
 * COMPLEXITY LIMITS:
 * - Max cyclomatic complexity: 15
 * - Max nested depth: 4
 * - Max function lines: 150
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
      // Infrastructure - all files (CommonJS, CDK artifacts, build outputs)
      "infra/**",
      // TypeScript declaration files
      "**/*.d.ts",
      // Jest setup and mocks (CommonJS)
      "jest.setup.js",
      "**/__mocks__/**",
      "tests/mocks/**",
      // Test scripts
      "test-*.js",
      // Package dist folders
      "packages/**/dist/**",
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

  // Temporarily disable React Compiler experimental rules (Issue #460)
  // These are optimization hints from the React 19 Compiler, not correctness issues.
  // The compiler automatically skips components with violations - code still works.
  // TODO: Re-enable and fix in dedicated optimization sprint when:
  //   1. React Compiler rules mature and false positives are resolved
  //   2. Proper time allocated for testing all 39+ affected components
  //   3. Better guidance from React team on recommended patterns
  {
    files: ["**/*.jsx", "**/*.tsx"],
    rules: {
      // Disable React Compiler experimental optimization rules
      "react-compiler/react-compiler": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/error-boundaries": "off",
      "react-hooks/incompatible-library": "off",
      "react-hooks/static-components": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },

  // PHASE 4: Enhanced Linting Rules (Issue #460)

  // Security rules - detect vulnerabilities early
  {
    plugins: {
      security: securityPlugin,
    },
    rules: {
      "security/detect-unsafe-regex": "error",
      "security/detect-buffer-noassert": "error",
      "security/detect-child-process": "warn",
      "security/detect-disable-mustache-escape": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-no-csrf-before-method-override": "error",
      "security/detect-non-literal-fs-filename": "warn",
      "security/detect-non-literal-regexp": "warn",
      "security/detect-non-literal-require": "off", // Too noisy with dynamic imports
      "security/detect-object-injection": "off", // Too many false positives
      "security/detect-possible-timing-attacks": "warn",
      "security/detect-pseudoRandomBytes": "error",
    },
  },

  // Accessibility rules - WCAG compliance for public sector
  {
    files: ["**/*.jsx", "**/*.tsx"],
    plugins: {
      "jsx-a11y": jsxA11yPlugin,
    },
    rules: {
      // Critical a11y rules
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/anchor-has-content": "error",
      "jsx-a11y/anchor-is-valid": "warn",
      "jsx-a11y/aria-activedescendant-has-tabindex": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-proptypes": "error",
      "jsx-a11y/aria-role": "error",
      "jsx-a11y/aria-unsupported-elements": "error",
      "jsx-a11y/heading-has-content": "error",
      "jsx-a11y/html-has-lang": "error",
      "jsx-a11y/iframe-has-title": "error",
      "jsx-a11y/img-redundant-alt": "warn",
      "jsx-a11y/interactive-supports-focus": "warn",
      "jsx-a11y/label-has-associated-control": "warn",
      "jsx-a11y/media-has-caption": "warn",
      "jsx-a11y/mouse-events-have-key-events": "warn",
      "jsx-a11y/no-access-key": "error",
      "jsx-a11y/no-autofocus": "warn",
      "jsx-a11y/no-distracting-elements": "error",
      "jsx-a11y/no-interactive-element-to-noninteractive-role": "warn",
      "jsx-a11y/no-noninteractive-element-interactions": ["warn", {
        "handlers": ["onClick", "onMouseDown", "onMouseUp", "onKeyPress", "onKeyDown", "onKeyUp"],
        "body": ["onError", "onLoad"],
        "iframe": ["onError", "onLoad"],
        "img": ["onError", "onLoad"]
      }],
      "jsx-a11y/no-noninteractive-tabindex": "warn",
      "jsx-a11y/no-redundant-roles": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
      "jsx-a11y/role-has-required-aria-props": "error",
      "jsx-a11y/role-supports-aria-props": "error",
      "jsx-a11y/scope": "error",
      "jsx-a11y/tabindex-no-positive": "warn",
    },
  },

  // Performance rules - React optimization
  {
    files: ["**/*.jsx", "**/*.tsx"],
    plugins: {
      "react-perf": reactPerfPlugin,
    },
    rules: {
      "react-perf/jsx-no-new-object-as-prop": "warn",
      "react-perf/jsx-no-new-array-as-prop": "warn",
      "react-perf/jsx-no-new-function-as-prop": "warn",
      "react-perf/jsx-no-jsx-as-prop": "warn",
    },
  },

  // Code quality rules - Unicorn (curated subset)
  {
    plugins: {
      unicorn: unicornPlugin,
    },
    rules: {
      // Error prevention
      "unicorn/error-message": "error",
      "unicorn/throw-new-error": "error",
      "unicorn/prefer-type-error": "error",

      // Better practices
      "unicorn/no-array-for-each": "warn",
      "unicorn/no-for-loop": "warn",
      "unicorn/prefer-array-find": "warn",
      "unicorn/prefer-array-some": "warn",
      "unicorn/prefer-includes": "warn",
      "unicorn/prefer-string-starts-ends-with": "warn",
      "unicorn/prefer-string-trim-start-end": "warn",
      "unicorn/prefer-modern-math-apis": "warn",
      "unicorn/prefer-number-properties": "warn",
      "unicorn/prefer-optional-catch-binding": "warn",

      // Clarity
      "unicorn/explicit-length-check": "warn",
      "unicorn/prefer-negative-index": "warn",
      "unicorn/prefer-node-protocol": "error",

      // Prevent issues
      "unicorn/no-instanceof-array": "error",
      "unicorn/no-new-array": "warn",
      "unicorn/no-new-buffer": "error",
      "unicorn/prefer-date-now": "warn",

      // Consistency
      "unicorn/better-regex": "warn",
      "unicorn/escape-case": "warn",
      "unicorn/no-hex-escape": "warn",
      "unicorn/number-literal-case": "warn",
      "unicorn/prefer-add-event-listener": "warn",

      // Too opinionated - disable
      "unicorn/filename-case": "off",
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-null": "off",
      "unicorn/prefer-top-level-await": "off",
      "unicorn/prefer-module": "off",
    },
  },

  // Complexity and code size limits
  {
    rules: {
      "complexity": ["warn", 15],
      "max-depth": ["warn", 4],
      "max-lines-per-function": ["warn", { max: 150, skipBlankLines: true, skipComments: true }],
      "max-nested-callbacks": ["warn", 3],
      "max-params": ["warn", 5],
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

  // Rule 5: Allow console in test/performance files
  {
    files: [
      "tests/**/*.ts",
      "tests/**/*.tsx",
      "scripts/**/*.ts",
    ],
    rules: {
      "no-console": "off",
    },
  },
];
