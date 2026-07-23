import { mkdir } from 'node:fs/promises'
import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'

/**
 * E2E (gated): admin resource-access grants editor (Epic #1202 Phase 3, #1206).
 *
 * Drives the new per-resource "Access" editor as the seeded administrator on all
 * three surfaces — a model (detail modal), an assistant (row "Manage access"
 * dialog), and an agent skill (row access dialog) — and captures visual evidence.
 * The editor loads the role + Google-group pickers via the admin-only server
 * actions; "Unrestricted" is shown when a resource has no grants.
 *
 * Gated: needs the host :3100 dev server + seeded users + local data
 * (see docs/guides/e2e-authenticated-testing.md).
 */

test.describe('Admin resource-access grants editor (#1206)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session against the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md',
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    await mkdir('.verification', { recursive: true })
  })

  test('model detail modal shows the Access (roles + groups) editor', async ({ page }, testInfo) => {
    await page.goto('/admin/models')
    // Wait for the models table to render at least one row.
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20000 })

    // Open the first row's actions menu → "Edit Model" to open the detail modal.
    await page.locator('table tbody tr').first().getByRole('button').last().click()
    await page.getByRole('menuitem', { name: /Edit Model/i }).click()

    // The modal's new "Access" label + the authoritative editor render.
    await expect(page.getByText('Access', { exact: true }).first()).toBeVisible({ timeout: 15000 })
    // Either "Unrestricted" or "Restricted" status badge is shown by the editor.
    await expect(
      page.getByText(/Unrestricted|Restricted/).first(),
    ).toBeVisible({ timeout: 15000 })

    await page.screenshot({
      path: `.verification/admin-resource-grants-model-${testInfo.project.name}.png`,
      fullPage: true,
    })
  })

  test('assistants table opens the Manage access dialog with the grants editor', async ({ page }, testInfo) => {
    await page.goto('/admin/assistants')
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20000 })

    // Row actions menu → "Manage access".
    await page.locator('table tbody tr').first().getByRole('button').last().click()
    await page.getByRole('menuitem', { name: /Manage access/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Manage access')).toBeVisible({ timeout: 15000 })
    await expect(dialog.getByText(/Unrestricted|Restricted/).first()).toBeVisible({ timeout: 15000 })
    // The role + group pickers render.
    await expect(dialog.getByText('Roles', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Google groups', { exact: true })).toBeVisible()

    await page.screenshot({
      path: `.verification/admin-resource-grants-assistant-${testInfo.project.name}.png`,
      fullPage: true,
    })
  })

  test('skills table opens the access dialog with the grants editor', async ({ page }, testInfo) => {
    // The skills list is the "Skills" tab of the agents dashboard, not a
    // standalone route.
    await page.goto('/admin/agents')
    await page.getByRole('tab', { name: /^Skills$/ }).click()

    // The skills table may take a moment; wait for a data row.
    const firstRow = page.locator('table tbody tr').first()
    await expect(firstRow).toBeVisible({ timeout: 20000 })

    // The per-row "Manage access" icon button (title="Manage access").
    await firstRow.getByRole('button', { name: /Manage access/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Manage access')).toBeVisible({ timeout: 15000 })
    await expect(dialog.getByText(/Unrestricted|Restricted/).first()).toBeVisible({ timeout: 15000 })

    await page.screenshot({
      path: `.verification/admin-resource-grants-skill-${testInfo.project.name}.png`,
      fullPage: true,
    })
  })
})
