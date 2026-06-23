import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for AI Studio E2E tests.
 *
 * Historically the repo shipped NO committed config (it was removed during an
 * "E2E rebuild"), so specs relied on an untracked local config for `baseURL` —
 * which made authenticated functional tests un-runnable for anyone without the
 * tribal-knowledge setup. This file makes the suite reproducible.
 *
 * baseURL precedence:
 *   - PLAYWRIGHT_BASE_URL when set (e.g. http://localhost:3100 for the host dev
 *     server used by authenticated functional specs)
 *   - http://localhost:3000 otherwise (the Docker dev app / default)
 *
 * Test tiers:
 *   - Guard specs (capability-{api,layout}-guards) run unauthenticated and are
 *     CI-safe — no env required.
 *   - Functional specs (capability-functional, nexus/*, admin-*) mint a session
 *     and are gated behind PLAYWRIGHT_AUTH_ENABLED. See
 *     docs/guides/e2e-authenticated-testing.md.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
