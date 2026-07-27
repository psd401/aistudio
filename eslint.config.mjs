import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import securityPlugin from "eslint-plugin-security";
import jsxA11yPlugin from "eslint-plugin-jsx-a11y";
import reactPerfPlugin from "eslint-plugin-react-perf";
import unicornPlugin from "eslint-plugin-unicorn";
import globals from "globals";
import loggingPlugin from "./eslint-plugin-logging/index.js";

/**
 * ESLint Configuration for AI Studio (ESLint 10 Flat Config)
 *
 * `eslint .` covers canonical first-party JavaScript and TypeScript, including
 * application code, tests, scripts, infrastructure, packages, and root
 * configuration/runtime files. The global ignore list is intentionally limited
 * to generated output, vendored dependencies, caches, declarations, and
 * tool-managed duplicate worktrees.
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
  // Generated output, vendored dependencies, caches, declarations, and
  // tool-managed duplicate checkouts. Canonical source must not be added here.
  {
    ignores: [
      ".next*/**",
      "out/**",
      "build/**",
      "**/dist/**",
      "**/node_modules/**",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
      ".playwright-mcp/**",
      "infra/cdk.out/**",
      "infra/.cdk.staging/**",
      // `infra/tsconfig.json` emits beside source. These paths are compiled
      // counterparts of linted TypeScript and are never canonical inputs.
      "infra/bin/**/*.js",
      "infra/lib/**/*.js",
      "infra/test/**/*.js",
      "infra/scripts/audit-iam-policies.js",
      "infra/scripts/secrets-migration/migrate-to-secrets-manager.js",
      "infra/database/lambda/db-init-handler.js",
      "infra/database/lambda/index.js",
      "infra/lambdas/file-processor/**/*.js",
      "infra/lambdas/layers/secret-cache/nodejs/index.js",
      "infra/lambdas/shared/iso-week.js",
      "infra/lambdas/textract-processor/index.js",
      "infra/lambdas/url-processor/index.js",
      ".claude/worktrees/**",
      "next-env.d.ts",
      "**/*.d.ts",
      "**/*.d.mts",
      "**/*.d.cts",
    ],
  },

  // Base ESLint recommended rules
  js.configs.recommended,

  // ESLint 10 promoted these rules to recommended. They remain warnings so the
  // diagnostics retain their intended category; --max-warnings 0 makes either
  // severity release-blocking.
  {
    rules: {
      "preserve-caught-error": "warn",
      "no-useless-assignment": "warn",
    },
  },

  // Node.js ESM/TypeScript entry points and support code.
  {
    files: [
      "*.{config,setup}.{js,mjs,cjs,ts,mts,cts}",
      "jest.*.js",
      "scripts/**/*.{js,mjs,cjs,ts,mts,cts}",
      "tests/**/*.{js,mjs,cjs,ts,mts,cts}",
      "infra/**/*.{js,mjs,cjs,ts,mts,cts}",
      "eslint-plugin-logging/**/*.js",
      ".jest/**/*.js",
      "packages/*/src/**/*.{js,mjs,cjs,ts,mts,cts}",
      "auth.ts",
      "instrumentation.ts",
      "middleware.ts",
      "server.ts",
      "voice-server.js",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },

  // CommonJS runtimes: standalone server/build code, Lambda handlers, agent
  // skills, Jest support, and the repository-local ESLint plugin.
  {
    files: [
      "**/*.cjs",
      ".jest/**/*.js",
      "**/__mocks__/**/*.js",
      "eslint-plugin-logging/**/*.js",
      "infra/**/*.js",
      "jest.*.js",
      "jest.setup.js",
      "tests/**/*.js",
      "voice-server.js",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
      sourceType: "commonjs",
    },
  },

  // Jest test globals apply only to test and mock code.
  {
    files: [
      "**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
      "**/__mocks__/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
      "tests/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
      "jest.setup.js",
    ],
    languageOptions: {
      globals: globals.jest,
    },
  },

  // AudioWorkletGlobalScope is not included in the `globals` package.
  {
    files: ["public/audio-worklet-processor.js"],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: "readonly",
        registerProcessor: "readonly",
        sampleRate: "readonly",
      },
    },
  },

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
        // Pinned (not "detect") because eslint-plugin-react's version auto-detection
        // calls the removed context.getFilename() API and crashes under ESLint 10.
        version: "19.2",
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

  // React Compiler rules - enabled now that compiler is stable (v1.0)
  // and enabled via reactCompiler: true in next.config.mjs
  // Violations cause the compiler to skip the component (still works, just not optimized)

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
  // Disabled: React Compiler (v1.0) handles automatic memoization at build time,
  // making manual useCallback/useMemo unnecessary. These rules are now redundant.
  {
    files: ["**/*.jsx", "**/*.tsx"],
    plugins: {
      "react-perf": reactPerfPlugin,
    },
    rules: {
      "react-perf/jsx-no-new-object-as-prop": "off",
      "react-perf/jsx-no-new-array-as-prop": "off",
      "react-perf/jsx-no-new-function-as-prop": "off",
      "react-perf/jsx-no-jsx-as-prop": "off",
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
      "unicorn/no-for-each": "warn",
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
      "@typescript-eslint/no-explicit-any": [
        "error",
        {
          fixToUnknown: true,
        },
      ],
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

  // Rule 5: Console is the native logging interface for tests, command-line
  // utilities, build scripts, Lambda handlers, and standalone agent skills.
  // These runtimes cannot import the Next.js logger alias.
  {
    files: [
      "tests/**/*.ts",
      "tests/**/*.tsx",
      "tests/**/*.js",
      "infra/**/*.{js,ts}",
      "scripts/**/*.ts",
      "scripts/**/*.mjs",
      "scripts/**/*.js",
    ],
    rules: {
      "no-console": "off",
    },
  },

  // These overrides must follow typescript-eslint's presets so its generic
  // module-style rule does not reject real CommonJS or Jest module isolation.
  {
    files: [
      "**/*.cjs",
      ".jest/**/*.js",
      "**/__mocks__/**/*.js",
      "eslint-plugin-logging/**/*.js",
      "infra/**/*.js",
      "jest.*.js",
      "jest.setup.js",
      "tests/**/*.js",
      "voice-server.js",
    ],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: [
      "**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
      "**/__mocks__/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
      "tests/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
      "jest.setup.js",
    ],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },

];
