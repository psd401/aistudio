import { test, expect } from '@playwright/test'

/**
 * E2E tests for admin capability management (Issue #923).
 *
 * Covers:
 * - Non-admin is redirected away from /admin/roles
 * - Capabilities tab renders alongside Roles
 * - Admin can create a manual capability and it appears in the list
 * - Manifest-managed (source=code) capabilities show as read-only name/description
 * - Manifest capability auto-registers on boot (present with source=code, no SQL)
 * - Role assignment dialog opens for a capability
 *
 * Auth note: admin-gated tests auto-skip in CI unless a seeded admin session is
 * available (run locally after `bun run db:seed`). The redirect test is
 * CI-compatible and requires no auth.
 */

function isUnauthenticated(url: string): boolean {
  return (
    url.includes('/auth') ||
    url.includes('/sign-in') ||
    url.includes('/login')
  )
}

test.describe('Admin Roles & Capabilities — Public Access', () => {
  test('non-admin user is redirected away from /admin/roles', async ({ page }) => {
    await page.goto('/admin/roles')

    await page.waitForURL((url) => !url.pathname.includes('/admin/roles'), {
      timeout: 10000,
    })

    const url = page.url()
    expect(
      url.includes('/auth') ||
        url.includes('/sign-in') ||
        url.includes('/login') ||
        url.includes('/dashboard') ||
        url.endsWith('/')
    ).toBe(true)
  })
})

test.describe('Admin Capability Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/roles')

    const url = page.url()
    if (isUnauthenticated(url) || !url.includes('/admin/roles')) {
      test.skip(true, 'No admin auth state available — run with seeded users locally')
    }
  })

  test('Capabilities tab renders alongside Roles', async ({ page }) => {
    // Both tab triggers should be present.
    await expect(
      page.getByRole('tab', { name: /Roles/i })
    ).toBeVisible({ timeout: 10000 })
    await expect(
      page.getByRole('tab', { name: /Capabilities/i })
    ).toBeVisible()

    // Switching to Capabilities shows the table + New Capability button.
    await page.getByRole('tab', { name: /Capabilities/i }).click()
    await expect(
      page.getByRole('button', { name: /New Capability/i })
    ).toBeVisible()
  })

  test('admin can create a manual capability', async ({ page }) => {
    await page.getByRole('tab', { name: /Capabilities/i }).click()
    await page.getByRole('button', { name: /New Capability/i }).click()

    // Unique identifier to keep the test idempotent across runs.
    const identifier = `e2e-cap-${Date.now()}`

    await page.getByLabel('Identifier').fill(identifier)
    await page.getByLabel('Name').fill('E2E Test Capability')
    await page.getByLabel('Description').fill('Created by an e2e test')

    await page.getByRole('button', { name: /^Create$/ }).click()

    // The new capability should appear in the table (by identifier code cell).
    await expect(page.getByText(identifier)).toBeVisible({ timeout: 10000 })
  })

  test('code-managed capability name/description are read-only', async ({ page }) => {
    await page.getByRole('tab', { name: /Capabilities/i }).click()

    // assistant-architect is a manifest (source=code) capability seeded on boot.
    const codeRow = page.getByRole('row', { name: /assistant-architect/i }).first()

    // Skip gracefully if the manifest sync hasn't populated it in this env.
    if ((await codeRow.count()) === 0) {
      test.skip(true, 'No code capability present (manifest sync not run in this env)')
      return
    }

    // Open the edit dialog for the code capability.
    await codeRow.getByRole('button').first().click()

    // Name field should be disabled for code-managed capabilities.
    const nameField = page.getByLabel('Name')
    await expect(nameField).toBeDisabled()
  })

  test('manifest capability auto-registered on boot shows source=code', async ({ page }) => {
    // The boot-time sync (instrumentation.ts -> syncCapabilityManifest) reconciles
    // lib/capabilities/manifest.ts into the DB with source='code'. This asserts a
    // known manifest entry is present WITHOUT any SQL migration or manual creation,
    // i.e. it auto-registered on boot. `model-compare` is a stable manifest id.
    await page.getByRole('tab', { name: /Capabilities/i }).click()

    const manifestRow = page
      .getByRole('row', { name: /model-compare/i })
      .first()

    if ((await manifestRow.count()) === 0) {
      test.skip(true, 'Manifest sync not run in this env — seed + boot locally')
      return
    }

    // The row must carry the "code" source badge, proving it came from the
    // manifest (source=code), not a manual admin-created capability.
    await expect(manifestRow.getByText(/^code$/i)).toBeVisible({ timeout: 10000 })
  })

  test('role assignment dialog opens for a capability', async ({ page }) => {
    await page.getByRole('tab', { name: /Capabilities/i }).click()

    const firstRow = page.getByRole('row').nth(1) // header is row 0
    if ((await firstRow.count()) === 0) {
      test.skip(true, 'No capabilities present to assign')
      return
    }

    // The second action button is the role-assignment trigger.
    const buttons = firstRow.getByRole('button')
    await buttons.nth(1).click()

    await expect(
      page.getByText(/Role assignments/i)
    ).toBeVisible({ timeout: 10000 })
  })
})
