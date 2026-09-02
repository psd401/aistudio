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
 *  - Happy path: an administrator opens the tab; it loads itself and renders
 *    the headline tiles, the daily strip, and the people / agents / sections
 *    tables. Seeding one document through the REST API (an audited `create`)
 *    moves the "Created" tile by at least one — the numbers are live, not a
 *    placeholder. Switching the range re-fetches cleanly.
 *  - Error state: when the stats request fails (the server-action POST is
 *    aborted at the network layer), the panel shows its inline error rather
 *    than a blank or stale tab.
 *  - Auth gate: a non-admin staff user gets no Usage tab (and, without
 *    approver rights, no page at all — the existing 404 mask). The
 *    unauthenticated gate is pinned by atrium-admin.guard.spec.ts.
 *
 * Auth: minted session cookies (helpers/session-auth). Gated behind
 * PLAYWRIGHT_AUTH_ENABLED.
 */

const SHOT_DIR = 'docs/verification/atrium-usage-dashboard'

type Page = import('@playwright/test').Page

function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

/** Open the Usage tab and wait for its self-load to render the tiles. */
async function openUsageTab(page: Page): Promise<void> {
  await page.goto('/admin/atrium')
  await page.getByRole('tab', { name: 'Usage' }).click()
  await expect(page.getByTestId('atrium-usage-panel')).toBeVisible()
  await expect(page.getByTestId('usage-tile-created')).toBeVisible({ timeout: 60000 })
}

/** The numeric value of a headline tile (locale separators stripped). */
async function readTile(page: Page, testId: string): Promise<number> {
  const text = await page.getByTestId(`${testId}-value`).textContent()
  return Number((text ?? '0').replace(/[^\d]/g, ''))
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
      await openUsageTab(page)
      const before = await readTile(page, 'usage-tile-created')

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
      const data = (await res.json())?.data
      expect(data?.id).toBeTruthy()
      created.push(data.id as string)

      // A fresh open re-fetches; the seeded create is in the 30-day window.
      await openUsageTab(page)
      expect(await readTile(page, 'usage-tile-created')).toBeGreaterThanOrEqual(before + 1)

      // The rest of the dashboard renders from the same load.
      await expect(page.getByTestId('usage-tile-authors')).toBeVisible()
      await expect(page.getByTestId('usage-tile-agents')).toBeVisible()
      await expect(page.getByTestId('usage-tile-inventory')).toBeVisible()
      await expect(page.getByTestId('usage-daily-strip')).toBeVisible()
      await expect(page.getByTestId('usage-authors')).toBeVisible()
      await expect(page.getByTestId('usage-agents')).toBeVisible()
      await expect(page.getByTestId('usage-sections')).toBeVisible()
      await page.screenshot({ path: `${SHOT_DIR}/01-usage-tab.png`, fullPage: true })

      // Range switch re-fetches without error. The daily strip is the
      // deterministic signal that the 7d data has REPLACED the 30d data: it
      // renders one bar per day of the range (30 → 7), whereas the Created
      // tile could satisfy a ">= 1" check against the stale 30d numbers.
      await page.getByRole('combobox', { name: 'Usage range' }).click()
      await page.getByRole('option', { name: 'Last 7 days' }).click()
      await expect(page.getByTestId('usage-daily-strip').locator('> div')).toHaveCount(7, {
        timeout: 30_000,
      })
      expect(await readTile(page, 'usage-tile-created')).toBeGreaterThanOrEqual(1)
      await expect(page.getByTestId('usage-error')).toHaveCount(0)
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

  test('a failed stats request shows the inline error instead of a blank tab', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    try {
      const page = await context.newPage()
      await openUsageTab(page)

      // Server actions travel as a POST carrying a `next-action` header; abort
      // the next one so the range change's fetch fails at the network layer.
      await page.route(
        (url) => url.pathname === '/admin/atrium',
        (route) => {
          const req = route.request()
          if (req.method() === 'POST' && req.headers()['next-action'] !== undefined) {
            void route.abort('failed')
          } else {
            void route.continue()
          }
        }
      )
      await page.getByRole('combobox', { name: 'Usage range' }).click()
      await page.getByRole('option', { name: 'Last 90 days' }).click()
      await expect(page.getByTestId('usage-error')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('usage-error')).toContainText(/usage/i)
      await page.unrouteAll()
    } finally {
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
