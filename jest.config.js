const nextJest = require('next/jest');

const createJestConfig = nextJest({
  dir: './',
});

const customJestConfig = {
  setupFilesAfterEnv: [
    '<rootDir>/jest.setup.js',
    '<rootDir>/tests/setup.ts'
  ],
  testEnvironment: 'jest-environment-jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^uuid$': '<rootDir>/tests/mocks/uuid.js',
    'lucide-react': '<rootDir>/tests/mocks/lucide-react.js',
    'next-auth/react': '<rootDir>/tests/mocks/next-auth.js',
    'next/navigation': '<rootDir>/tests/mocks/next-navigation.js',
    '^@radix-ui/(.*)$': '<rootDir>/tests/mocks/radix-ui-primitives.js',
    '^@/components/ui/select$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/dialog$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/label$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/button$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/input$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/card$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/tabs$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/badge$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/dropdown-menu$': '<rootDir>/tests/mocks/dropdown-menu.js',
    '^@/components/ui/scroll-area$': '<rootDir>/tests/mocks/scroll-area.js',
    '^@/components/ui/table$': '<rootDir>/tests/mocks/radix-ui.js'
  },
  setupFiles: ['<rootDir>/.jest/setEnvVars.js'],
  // NOTE: the Atrium markdown render pipeline (lib/content/render/markdown-render.ts)
  // imports the pure-ESM unified/remark/rehype ecosystem, which next/jest (SWC)
  // does not transform in node_modules (transformIgnorePatterns is ineffective for
  // it under next/jest). That module is therefore not jest-loadable: tests reaching
  // it must jest.mock("@/lib/content/render/markdown-render"), and the pipeline is
  // verified by tests/smoke/atrium-markdown-render.smoke.ts (Bun) + the E2E.
  transformIgnorePatterns: [
    'node_modules/(?!(lucide-react|next-auth|@next-auth|nanoid)/)'
  ],
  // Git worktrees under .claude/worktrees/ are full repo checkouts. Left
  // unignored, a run from the repo root crawls every worktree and multiplies
  // the discovered suite (~450 -> ~3600) with duplicate haste modules.
  // These MUST stay anchored to <rootDir>: an unanchored '/.claude/worktrees/'
  // also matches when rootDir *is* a worktree, so jest silently discovers zero
  // tests and exits "No tests found" instead of failing a check.
  modulePathIgnorePatterns: [
    '<rootDir>/infra/cdk.out/',
    '<rootDir>/.next/',
    '<rootDir>/.claude/worktrees/',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/e2e/',
    '/.next/',
    // Infra has its own Jest config, except the triage worker's focused
    // runtime-boundary tests. Keep those in the Lambda directory while
    // executing them through the root Jest gate used by CI.
    '/infra/(?!lambdas/agent-triage-poll/__tests__/)',
    '/infra/cdk.out/',
    '<rootDir>/.claude/worktrees/', // Nested worktrees only - see note above
    'mock-sse-factory.ts' // Utility file, not a test file
  ]
};

module.exports = createJestConfig(customJestConfig);
