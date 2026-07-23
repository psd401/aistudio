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

    const ruleRow = (value: string) =>
      page.locator('[data-testid^="rule-row-"]').filter({ hasText: value })

    // Add a hand-picked email rule.
    await page.getByTestId('rule-value-input').fill(pickEmail)
    await page.getByTestId('rule-add').click()
    await expect(ruleRow(pickEmail)).toHaveCount(1, { timeout: 10000 })

    // Switch the rule type to prefix and add a prefix rule.
    await page.getByTestId('rule-type-select').click()
    await page.getByRole('option', { name: 'Email prefix' }).click()
    await page.getByTestId('rule-value-input').fill(prefixValue)
    await page.getByTestId('rule-add').click()
    await expect(ruleRow(prefixValue)).toHaveCount(1, { timeout: 10000 })

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
    // Assert on the row locator (not the table, which is replaced by the empty
    // state once the last rule is gone).
    for (const value of [pickEmail, prefixValue]) {
      await ruleRow(value).getByRole('button', { name: 'Delete rule' }).click()
      await expect(ruleRow(value)).toHaveCount(0, { timeout: 10000 })
    }
  })

  // Phase 1 (#1204): the Role-mappings tab. Group membership is written only by
  // the sync Lambda (absent in local dev), so we seed one active group directly
  // and drive the tab + its group/role pickers against it.
  test('shows the role-mappings tab with a mapped group→role', async ({ page }, testInfo) => {
    const postgres = (await import('postgres')).default
    const sql = postgres(
      process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/aistudio',
      { ssl: process.env.E2E_DB_SSL === 'true' },
    )
    const stamp = Date.now()
    const groupEmail = `e2e-map-${stamp}@psd401.net`
    let groupId: string | undefined
    let mappingId: string | undefined

    try {
      // Seed an active group + a mapping to whatever role the seed provides.
      const [group] = await sql<{ id: string }[]>`
        INSERT INTO groups (group_email, name, source, is_active)
        VALUES (${groupEmail}, 'E2E Mapping Group', 'manual', true)
        RETURNING id`
      groupId = group.id
      const [role] = await sql<{ id: number; name: string }[]>`
        SELECT id, name FROM roles ORDER BY name LIMIT 1`
      const [mapping] = await sql<{ id: string }[]>`
        INSERT INTO group_role_mappings (group_email, role_id)
        VALUES (${groupEmail}, ${role.id}) RETURNING id`
      mappingId = mapping.id

      await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
      await page.goto('/admin/groups')
      await expect(page.getByTestId('groups-admin')).toBeVisible({ timeout: 15000 })

      // Full-page shot: the new "Role mappings" tab + relative "Last run" + Sync now.
      await mkdir('.verification', { recursive: true })
      await page.screenshot({
        path: `.verification/admin-groups-overview-${testInfo.project.name}.png`,
        fullPage: true,
      })

      // Open the Role-mappings tab and confirm the seeded mapping renders.
      await page.getByTestId('tab-mappings').click()
      await expect(page.getByTestId('mappings-table')).toBeVisible({ timeout: 10000 })
      await expect(
        page.locator('[data-testid^="mapping-row-"]').filter({ hasText: groupEmail }),
      ).toHaveCount(1)
      await expect(page.getByText(role.name, { exact: true }).first()).toBeVisible()

      await page.screenshot({
        path: `.verification/admin-groups-role-mappings-${testInfo.project.name}.png`,
        fullPage: true,
      })
    } finally {
      if (mappingId) await sql`DELETE FROM group_role_mappings WHERE id = ${mappingId}`
      if (groupId) await sql`DELETE FROM groups WHERE id = ${groupId}`
      await sql.end()
    }
  })
})
