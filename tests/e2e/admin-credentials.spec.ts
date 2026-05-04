import { test, expect } from '@playwright/test'

/**
 * E2E tests for the Admin Agent Credentials page (Issue #933)
 *
 * Covers:
 * - Non-admin is redirected
 * - Admin can access /admin/agents/credentials
 * - Requests tab renders table with expected columns
 * - Provision tab renders the form
 * - Audit Log tab renders table
 * - Provisioning form validates inputs
 *
 * Auth note: tests requiring admin session auto-skip in CI unless
 * PLAYWRIGHT_AUTH_ENABLED=true is set.
 */

test.describe('Credentials Page — Public Access', () => {
  test('non-admin user is redirected away from /admin/agents/credentials', async ({ page }) => {
    await page.goto('/admin/agents/credentials')

    // Should redirect to sign-in or dashboard
    await page.waitForURL((url) => !url.pathname.includes('/admin/agents/credentials'), {
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

test.describe('Credentials Page — Admin', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/agents/credentials')

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

  test('page loads and renders heading', async ({ page }) => {
    const heading = page.locator('h1').filter({
      hasText: /Agent Credentials/i,
    })
    await expect(heading).toBeVisible({ timeout: 10000 })
  })

  test('tabs render correctly', async ({ page }) => {
    const tabs = ['Requests', 'Provision', 'Usage', 'Audit Log']

    for (const tab of tabs) {
      const trigger = page.locator('[role="tab"]').filter({ hasText: tab })
      await expect(trigger).toBeVisible({ timeout: 5000 })
    }
  })

  test('requests tab shows table with expected columns', async ({ page }) => {
    // Default tab is Requests
    const headers = [
      'Credential Name',
      'Requested By',
      'Reason',
      'Status',
      'Created',
    ]

    for (const header of headers) {
      const th = page.locator('th').filter({ hasText: header })
      await expect(th).toBeVisible({ timeout: 5000 })
    }
  })

  test('provision tab renders form', async ({ page }) => {
    // Click Provision tab
    const provisionTab = page.locator('[role="tab"]').filter({ hasText: 'Provision' })
    await provisionTab.click()

    // Should see form elements
    await expect(page.locator('label').filter({ hasText: 'Credential Name' })).toBeVisible({ timeout: 5000 })
    await expect(page.locator('label').filter({ hasText: 'Secret Value' })).toBeVisible({ timeout: 5000 })
    await expect(page.locator('button').filter({ hasText: 'Provision Secret' })).toBeVisible({ timeout: 5000 })
  })

  test('provision form submit button is disabled when fields empty', async ({ page }) => {
    const provisionTab = page.locator('[role="tab"]').filter({ hasText: 'Provision' })
    await provisionTab.click()

    const submitButton = page.locator('button').filter({ hasText: 'Provision Secret' })
    await expect(submitButton).toBeDisabled({ timeout: 5000 })
  })

  test('audit log tab renders table', async ({ page }) => {
    const auditTab = page.locator('[role="tab"]').filter({ hasText: 'Audit Log' })
    await auditTab.click()

    const headers = ['Credential Name', 'Scope', 'Action', 'Actor', 'Time']

    for (const header of headers) {
      const th = page.locator('th').filter({ hasText: header })
      await expect(th).toBeVisible({ timeout: 5000 })
    }
  })

  test('refresh button works without error', async ({ page }) => {
    const refreshButton = page.locator('button').filter({ hasText: /Refresh/i })
    await expect(refreshButton).toBeVisible({ timeout: 10000 })
    await refreshButton.click()

    // Should not navigate away or show error toast
    await page.waitForTimeout(1000)
    const url = page.url()
    expect(url).toContain('/admin/agents/credentials')
  })
})
