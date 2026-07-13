import { mkdir } from 'node:fs/promises'
import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'

/**
 * E2E (gated): Google Directory group-sync admin (Epic #1202, Phase 0 / #1203).
 *
 * Drives /admin/groups as the seeded administrator and exercises the selection-
 * rule CRUD that backs the sync (both a hand-picked email and a prefix rule),
 * plus the status/browser surfaces. Group membership itself is written only by
 * the sync Lambda (not present in local dev), so the groups table renders its
 * empty state — the selection rules are the deterministic, DB-backed surface.
 *
 * Gated: needs the host :3100 dev server + seeded users + migrations 106/107
 * applied (see docs/guides/e2e-authenticated-testing.md).
 */

test.describe('Admin groups page (#1203)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session against the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md',
  )

  test('renders sync status and manages selection rules (pick + prefix)', async ({
    page,
  }, testInfo) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    await page.goto('/admin/groups')

    // Admin authorization succeeded (no redirect to auth) and the page renders.
    const heading = page.locator('h1').filter({ hasText: /^Groups$/ })
    await expect(heading).toBeVisible({ timeout: 15000 })
    expect(page.url()).toContain('/admin/groups')
    await expect(page.getByTestId('groups-admin')).toBeVisible()

    // Status summary + Sync now control are present (admin-gated).
    await expect(page.getByTestId('summary-active')).toBeVisible()
    await expect(page.getByTestId('groups-sync-now')).toBeVisible()

    // Unique values so the spec is idempotent against a shared local DB.
    const stamp = Date.now()
    const pickEmail = `e2e-pick-${stamp}@psd401.net`
    const prefixValue = `e2e-prefix-${stamp}-`

    // Add a hand-picked email rule.
    await page.getByTestId('rule-value-input').fill(pickEmail)
    await page.getByTestId('rule-add').click()
    await expect(page.getByTestId('rules-table')).toContainText(pickEmail, {
      timeout: 10000,
    })

    // Switch the rule type to prefix and add a prefix rule.
    await page.getByTestId('rule-type-select').click()
    await page.getByRole('option', { name: 'Email prefix' }).click()
    await page.getByTestId('rule-value-input').fill(prefixValue)
    await page.getByTestId('rule-add').click()
    await expect(page.getByTestId('rules-table')).toContainText(prefixValue, {
      timeout: 10000,
    })

    // Both modes are now visible in the rules table.
    await expect(page.getByText('Email', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Prefix', { exact: true }).first()).toBeVisible()

    // Visual evidence for the PR (screenshot_dir default = .verification).
    await mkdir('.verification', { recursive: true })
    await page.screenshot({
      path: `.verification/admin-groups-${testInfo.project.name}.png`,
      fullPage: true,
    })

    // Clean up: delete the two rules we added so the shared DB stays tidy.
    for (const value of [pickEmail, prefixValue]) {
      const row = page.locator('[data-testid^="rule-row-"]').filter({ hasText: value })
      await row.getByRole('button', { name: 'Delete rule' }).click()
      await expect(page.getByTestId('rules-table')).not.toContainText(value, {
        timeout: 10000,
      })
    }
  })
})
