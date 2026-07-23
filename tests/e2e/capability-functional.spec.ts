import { test, expect, type Page } from './fixtures'
import { authenticateContext } from './helpers/session-auth'

/**
 * E2E: authenticated functional coverage for #928 capability-gated surfaces.
 *
 * Unlike the guard specs (capability-{api,layout}-guards), these drive the real
 * UI as a logged-in admin to prove the features RENDER and RESPOND after the
 * hasToolAccess -> hasCapabilityAccess migration. `navigation renders` is the
 * direct regression guard for the "no navigation" breakage that happened when
 * code expecting navigation_items.capability_id ran against an un-migrated DB.
 *
 * Auth: mints a NextAuth session cookie for the seeded admin (test@example.com)
 * via tests/e2e/helpers/session-auth — requires AUTH_SECRET in env and a server
 * whose secret matches it (the host dev server, NOT the prod-built container).
 * See docs/guides/e2e-authenticated-testing.md.
 *
 * Gated behind PLAYWRIGHT_AUTH_ENABLED so default CI (no seeded session) skips.
 */

test.describe('Capability functional flows (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  // Direct regression guard for the capability migration: the left nav is built
  // from /api/navigation (navigation_items joined to capabilities). A schema/DB
  // drift (tool_id vs capability_id) made that query fail -> empty nav. The nav
  // items render as links by href even when the sidebar is collapsed (icon-only).
  test('navigation renders for an authenticated user', async ({ page }) => {
    await page.goto('/dashboard')
    const nav = page.getByRole('navigation')
    await expect(nav).toBeVisible({ timeout: 15_000 })
    // Data-driven nav items (from the DB) must be present, not just the logo.
    await expect(nav.locator('a[href="/nexus"]')).toBeVisible()
    await expect(nav.locator('a[href]')).not.toHaveCount(0)
    expect(await nav.locator('a[href]').count()).toBeGreaterThan(2)
  })

  test('/compare renders and accepts input', async ({ page }) => {
    await page.goto('/compare')
    await expect(
      page.getByRole('heading', { name: 'Model Comparison', level: 1 })
    ).toBeVisible({ timeout: 15_000 })

    // Both model pickers render (default models are preselected).
    await expect(page.getByRole('combobox', { name: /Select first model/i })).toBeVisible()
    await expect(page.getByRole('combobox', { name: /Select second model/i })).toBeVisible()

    // The form is interactive: entering a prompt enables the run button. A live
    // stream assertion is intentionally omitted — it depends on distinct model
    // selection plus working provider creds and is too flaky for a CI gate; the
    // streaming/polling path is covered by model-compare-polling.spec.ts.
    await page.getByRole('textbox', { name: /Comparison prompt/i }).fill('Reply with only the word OK.')
    await expect(
      page.getByRole('button', { name: /Submit comparison|Start comparison/i }).first()
    ).toBeEnabled()
  })

  test('/schedules grants access and renders', async ({ page }) => {
    await assertCapabilityPageLoads(page, '/schedules')
  })

  test('/repositories grants access and renders', async ({ page }) => {
    await assertCapabilityPageLoads(page, '/repositories')
  })

  test('/nexus/decision-capture grants access and renders', async ({ page }) => {
    await assertCapabilityPageLoads(page, '/nexus/decision-capture')
  })
})

/**
 * A capability-gated page loads for an authorized user when the guard does NOT
 * redirect (URL stays on the route) and the app shell mounted (nav + main
 * landmarks present) — i.e. not an error/empty page. Page-specific content
 * selectors are intentionally avoided so the assertion stays stable across UI
 * churn; the point is "capability granted + page mounted".
 */
async function assertCapabilityPageLoads(page: Page, route: string): Promise<void> {
  // `goto` resolves on the load event. Do NOT waitForLoadState('networkidle') —
  // capability pages poll (e.g. /schedules execution status) and, under concurrent
  // test load on the dev server, the network never goes idle, so the wait times out
  // flakily. The element assertions below are the real readiness signal (Playwright
  // auto-waits on them).
  await page.goto(route)
  expect(new URL(page.url()).pathname).toBe(route)
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('main').first()).toBeVisible()
}
