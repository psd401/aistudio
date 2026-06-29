import { test, expect, type Page } from './fixtures'

/**
 * E2E tests for the Admin Agent Credentials tab (Issue #933)
 *
 * The Credentials UI lives as a tab on the /admin/agents dashboard,
 * not as a standalone route. These tests open the dashboard, switch
 * to the Credentials tab, then exercise its sub-tabs and the
 * Provision form.
 *
 * Auth note: tests requiring admin session auto-skip in CI unless
 * PLAYWRIGHT_AUTH_ENABLED=true is set.
 */

const DASHBOARD_PATH = '/admin/agents'

async function openCredentialsTab(page: Page) {
  const credentialsTab = page.locator('[role="tab"]').filter({ hasText: 'Credentials' }).first()
  await credentialsTab.click()
}

test.describe('Admin Agents Dashboard — Public Access', () => {
  test('non-admin user is redirected away from /admin/agents', async ({ page }) => {
    // Clear cookies to ensure unauthenticated state
    await page.context().clearCookies()
    await page.goto(DASHBOARD_PATH)

    await page.waitForURL((url) => !url.pathname.startsWith('/admin/agents'), {
      timeout: 10000,
    })

    const url = page.url()
    expect(
      url.includes('/auth') ||
        url.includes('/sign-in') ||
        url.includes('/login') ||
        url.includes('/dashboard') ||
        new URL(url).pathname === '/'
    ).toBe(true)
  })
})

test.describe('Credentials Tab — Admin', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(DASHBOARD_PATH)

    const url = page.url()
    if (
      url.includes('/auth') ||
      url.includes('/sign-in') ||
      url.includes('/login') ||
      url.includes('/dashboard') ||
      new URL(url).pathname === '/'
    ) {
      test.skip(
        true,
        'No admin auth state available — run with seeded users locally'
      )
    }

    await openCredentialsTab(page)
  })

  test('credentials tab exposes expected sub-tabs', async ({ page }) => {
    const subTabs = ['Requests', 'Provision', 'Usage', 'Audit Log']

    for (const tab of subTabs) {
      const trigger = page.locator('[role="tab"]').filter({ hasText: tab })
      await expect(trigger.first()).toBeVisible({ timeout: 5000 })
    }
  })

  test('requests sub-tab shows table with expected columns', async ({ page }) => {
    const headers = [
      'Credential Name',
      'Requested By',
      'Reason',
      'Skill Context',
      'Ticket',
      'Status',
      'Created',
      'Actions',
    ]

    for (const header of headers) {
      const th = page.locator('th').filter({ hasText: header })
      await expect(th.first()).toBeVisible({ timeout: 5000 })
    }
  })

  test('provision sub-tab renders form', async ({ page }) => {
    const provisionTab = page.locator('[role="tab"]').filter({ hasText: 'Provision' })
    await provisionTab.click()

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

  test('audit log sub-tab renders table', async ({ page }) => {
    const auditTab = page.locator('[role="tab"]').filter({ hasText: 'Audit Log' })
    await auditTab.click()

    const headers = ['Credential Name', 'Scope', 'Action', 'Actor', 'Time']

    for (const header of headers) {
      const th = page.locator('th').filter({ hasText: header })
      await expect(th.first()).toBeVisible({ timeout: 5000 })
    }
  })
})
