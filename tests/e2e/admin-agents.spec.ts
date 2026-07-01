import { test, expect } from './fixtures'

/**
 * E2E tests for the Agent Platform Telemetry Dashboard (Issue #890)
 *
 * Covers:
 * - Admin can access /admin/agents
 * - Non-admin is redirected
 * - Stats cards render
 * - Date range selector triggers reload
 * - Tab navigation works
 *
 * Auth note: tests requiring admin session auto-skip in CI unless
 * PLAYWRIGHT_AUTH_ENABLED=true is set.
 */

test.use({ storageState: 'tests/e2e/.auth/user-a.json' })

test.describe('Agent Dashboard — Public Access', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('non-admin user is redirected away from /admin/agents', async ({ page }) => {
    await page.goto('/admin/agents')

    // Should redirect to sign-in or dashboard — not remain on /admin/agents
    await page.waitForURL((url) => !url.pathname.includes('/admin/agents'), {
      timeout: 10000,
    })

    const url = page.url()
    expect(
      url.includes('/auth') ||
        url.includes('/sign-in') ||
        url.includes('/login') ||
        url.includes('/dashboard')
    ).toBe(true)
  })
})

test.describe('Agent Dashboard — Admin', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/agents')

    // If no admin auth state, skip the rest of the suite
    const url = page.url()
    if (
      url.includes('/auth') ||
      url.includes('/sign-in') ||
      url.includes('/login')
    ) {
      test.skip(
        true,
        'No admin auth state available — run with seeded users locally'
      )
      return
    }
  })

  test('dashboard page loads and renders heading', async ({ page }) => {
    const heading = page.locator('h1').filter({
      hasText: /Agent Platform Dashboard/i,
    })
    await expect(heading).toBeVisible({ timeout: 10000 })
  })

  test('stats cards section renders', async ({ page }) => {
    // AgentStatsCards renders a grid of shadcn <Card>s. shadcn cards carry the
    // 'bg-card' class (lowercase) — the old [class*="Card"] (capital C) matched
    // nothing. Match the lowercase card class.
    const statsSection = page
      .locator('[class*="grid"]')
      .filter({ has: page.locator('[class*="card"]') })
      .first()
    await expect(statsSection).toBeVisible({ timeout: 15000 })
  })

  test('tab navigation renders all tabs', async ({ page }) => {
    const tabs = [
      'Usage',
      'Cost',
      'Adoption',
      'Failures',
      'Health',
      'Safety',
      'Patterns',
      'Feedback',
    ]

    for (const tab of tabs) {
      const trigger = page.locator('[role="tab"]').filter({ hasText: tab })
      await expect(trigger).toBeVisible({ timeout: 5000 })
    }
  })

  test('failures tab loads and shows table or empty state', async ({ page }) => {
    await page.waitForSelector('[role="tab"][aria-selected="true"]', {
      timeout: 10000,
    })
    const failuresTab = page
      .locator('[role="tab"]')
      .filter({ hasText: 'Failures' })
    await failuresTab.click()
    const card = page.locator('text=/Agent Failures/i').first()
    await expect(card).toBeVisible({ timeout: 10000 })
    // Either rows render OR the empty-state message shows
    const emptyOrTable = page.locator(
      'text=/No failures match these filters|Showing/i',
    )
    await expect(emptyOrTable.first()).toBeVisible({ timeout: 10000 })
  })

  test('failures filters are interactive', async ({ page }) => {
    await page.waitForSelector('[role="tab"][aria-selected="true"]', {
      timeout: 10000,
    })
    await page.locator('[role="tab"]').filter({ hasText: 'Failures' }).click()
    // Acknowledge button starts disabled (no rows selected)
    const ackBtn = page.locator('button').filter({ hasText: /Acknowledge \(0\)/ })
    await expect(ackBtn).toBeVisible({ timeout: 10000 })
    await expect(ackBtn).toBeDisabled()
  })

  test('clicking a tab switches content', async ({ page }) => {
    // Wait for the default tab to be selected before switching
    await page.waitForSelector('[role="tab"][aria-selected="true"]', {
      timeout: 10000,
    })

    // Click the Safety tab
    const safetyTab = page
      .locator('[role="tab"]')
      .filter({ hasText: 'Safety' })
    await safetyTab.click()

    // Should see the safety content — either data or empty state
    const safetyContent = page.locator('text=/Guardrail Flags/i').first()
    await expect(safetyContent).toBeVisible({ timeout: 10000 })
  })

  test('date range selector is present and interactive', async ({ page }) => {
    // Find the date range selector
    const selector = page.locator('button[role="combobox"]').first()
    await expect(selector).toBeVisible({ timeout: 10000 })

    // Open and select a different range
    await selector.click()
    const option = page
      .locator('[role="option"]')
      .filter({ hasText: 'Last 7 days' })
    await expect(option).toBeVisible({ timeout: 5000 })
    await option.click()

    // Selector should now show the new value
    await expect(selector).toContainText('Last 7 days')
  })

  test('refresh button is present', async ({ page }) => {
    const refreshButton = page
      .locator('button')
      .filter({ hasText: /Refresh/i })
    await expect(refreshButton).toBeVisible({ timeout: 10000 })
  })

  // admin-agents-cache-cost (issue #1089): the Cost tab's token×pricing view is
  // the source-of-truth model-cost panel. After the GLM-5 -> Sonnet 5 migration
  // it must render the Bedrock cache-read / cache-write token columns and a
  // cache-aware cost figure.
  test('cost tab renders cache-aware model cost with cache token columns', async ({
    page,
  }, testInfo) => {
    await page.waitForSelector('[role="tab"][aria-selected="true"]', {
      timeout: 10000,
    })
    await page.locator('[role="tab"]').filter({ hasText: 'Cost' }).click()

    // Source-of-truth panel heading always renders on the Cost tab.
    const panelHeading = page
      .locator('text=/Model cost \(tokens × pricing\)/i')
      .first()
    await expect(panelHeading).toBeVisible({ timeout: 15000 })

    // The cache-aware cost figure is documented in the panel description — it
    // renders regardless of whether there is token data in the window.
    await expect(
      page.locator('text=/cache-aware/i').first()
    ).toBeVisible({ timeout: 10000 })

    // When there is recorded token usage, the by-model table renders the
    // cache-read + cache-write columns; otherwise the empty state shows.
    // Either satisfies the CI-safe assertion; both are valid renders.
    const cacheReadHeader = page
      .locator('th')
      .filter({ hasText: /Cache read tok/i })
      .first()
    const emptyState = page
      .locator('text=/No token usage recorded/i')
      .first()
    await expect(cacheReadHeader.or(emptyState)).toBeVisible({ timeout: 10000 })

    if (await cacheReadHeader.isVisible().catch(() => false)) {
      // Data present — assert BOTH cache columns exist alongside the cost col.
      await expect(
        page.locator('th').filter({ hasText: /Cache write tok/i }).first()
      ).toBeVisible()
    }

    // Visual evidence for the PR (screenshot_dir default = .verification).
    await page.screenshot({
      path: `.verification/admin-agents-cache-cost-${testInfo.project.name}.png`,
      fullPage: true,
    })
  })
})
