import { test, expect } from '@playwright/test'

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

test.describe('Agent Dashboard — Public Access', () => {
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
    // Wait for stats to load — skeleton or actual cards
    const statsSection = page
      .locator('[class*="grid"]')
      .filter({ has: page.locator('[class*="Card"]') })
      .first()
    await expect(statsSection).toBeVisible({ timeout: 10000 })
  })

  test('tab navigation renders all tabs', async ({ page }) => {
    const tabs = [
      'Usage',
      'Cost',
      'Adoption',
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

  test('clicking a tab switches content', async ({ page }) => {
    // Wait for initial load
    await page.waitForTimeout(2000)

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
})
