import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
  SEEDED_STAFF_EMAIL,
  SEEDED_STAFF_SUB,
} from './helpers/session-auth'
import { mkdirSync } from 'node:fs'

/**
 * E2E functional coverage for the Atrium usage dashboard — the Usage tab of
 * /admin/atrium (components/atrium/admin/atrium-usage-panel.tsx, backed by
 * getAtriumUsageStatsAction over content_audit_logs).
 *
 *  - An administrator sees the Usage tab; opening it renders the headline
 *    tiles, the daily strip, and the people / agents / sections tables.
 *  - Seeding one document through the REST API (an audited `create`) is
 *    reflected in the "Created" tile — the numbers come from the trail, not
 *    from a placeholder.
 *  - Switching the range re-fetches without an error.
 *  - A non-admin staff user gets no Usage tab (and, without approver rights,
 *    no page at all — the existing 404 mask).
 *
 * Auth: minted session cookies (helpers/session-auth). Gated behind
 * PLAYWRIGHT_AUTH_ENABLED.
 */

const SHOT_DIR = 'docs/verification/atrium-usage-dashboard'

function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

test.describe('Atrium usage dashboard (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true })
  })

  test('an administrator sees live authoring numbers and can change the range', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const page = await context.newPage()
    const created: string[] = []
    try {
      // Baseline "Created" for the default 30d range, then seed one audited
      // create and expect the tile to move by at least one.
      await page.goto('/admin/atrium')
      await page.getByRole('tab', { name: 'Usage' }).click()
      const panel = page.getByTestId('atrium-usage-panel')
      await expect(panel).toBeVisible()
      const createdTile = page.getByTestId('usage-tile-created')
      await expect(createdTile).toBeVisible()
      const before = Number(
        (await createdTile.locator('p').nth(1).textContent())?.replace(/[^\d]/g, '') ?? '0'
      )

      const res = await page.request.post('/api/v1/content', {
        data: {
          kind: 'document',
          title: `Usage probe ${runToken()}`,
          body: '# Usage probe\n\nOne audited create.',
          bodyFormat: 'markdown',
          visibility: { level: 'private' },
        },
      })
      expect(res.status()).toBe(201)
      created.push((await res.json()).data.id as string)

      await page.reload()
      await page.getByRole('tab', { name: 'Usage' }).click()
      await expect(page.getByTestId('usage-tile-created')).toBeVisible()
      await expect
        .poll(
          async () =>
            Number(
              (await page.getByTestId('usage-tile-created').locator('p').nth(1).textContent())
                ?.replace(/[^\d]/g, '') ?? '0'
            ),
          { timeout: 30_000 }
        )
        .toBeGreaterThanOrEqual(before + 1)

      // The rest of the dashboard renders from the same load.
      await expect(page.getByTestId('usage-tile-authors')).toBeVisible()
      await expect(page.getByTestId('usage-tile-agents')).toBeVisible()
      await expect(page.getByTestId('usage-tile-inventory')).toBeVisible()
      await expect(page.getByTestId('usage-daily-strip')).toBeVisible()
      await expect(page.getByTestId('usage-authors')).toBeVisible()
      await expect(page.getByTestId('usage-agents')).toBeVisible()
      await expect(page.getByTestId('usage-sections')).toBeVisible()
      await page.screenshot({ path: `${SHOT_DIR}/01-usage-tab.png`, fullPage: true })

      // Range switch re-fetches without error and keeps the tiles.
      await page.getByRole('combobox', { name: 'Usage range' }).click()
      await page.getByRole('option', { name: 'Last 7 days' }).click()
      await expect(page.getByTestId('atrium-usage-panel')).toHaveAttribute('aria-busy', 'false', {
        timeout: 30_000,
      })
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect(page.getByTestId('usage-tile-created')).toBeVisible()
      await page.screenshot({ path: `${SHOT_DIR}/02-usage-7d.png`, fullPage: false })
    } finally {
      for (const id of created) {
        try {
          await page.request.delete(`/api/v1/content/${id}`)
        } catch {
          // Ignored on purpose — teardown must never mask the assertion.
        }
      }
      await context.close()
    }
  })

  test('a non-admin staff user does not get the Usage tab', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_STAFF_EMAIL, SEEDED_STAFF_SUB)
    try {
      const page = await context.newPage()
      const resp = await page.goto('/admin/atrium')
      // Either masked entirely (404, no approver rights) or, if the seeded
      // staff user happens to be a collection approver, the page without the
      // administrator-only tabs. Both are correct; a visible Usage tab is not.
      if (resp?.status() === 200) {
        await expect(page.getByRole('tab', { name: 'Approvals' })).toBeVisible()
        await expect(page.getByRole('tab', { name: 'Usage' })).toHaveCount(0)
      } else {
        expect(resp?.status()).toBe(404)
      }
    } finally {
      await context.close()
    }
  })
})
