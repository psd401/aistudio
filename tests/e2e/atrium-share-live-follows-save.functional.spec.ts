import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'
import { mkdirSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'

/**
 * E2E (gated): two Atrium sharing defects.
 *
 *  - SHARE DIALOG CONTAINMENT. The dialog is a single-column grid; a long
 *    reader URL used to size that column wider than the 680px box, so the link
 *    row, Level picker, status card, connector cards and footer all spilled out
 *    of the dialog. Every row must sit inside the dialog, at desktop AND phone
 *    width.
 *  - LIVE FOLLOWS THE LATEST SAVE. A reader of `/c/{slug}` used to see whatever
 *    version was live at the last explicit Republish — weeks stale — while the
 *    editor showed today's. A save to a Live object now makes the reader serve
 *    the new version, with no Republish, and the "UP TO DATE" pill is true.
 *
 * Auth: see helpers/session-auth. Gated behind PLAYWRIGHT_AUTH_ENABLED.
 */

const SHOT_DIR = '.verification'

function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

/** Right edge of `inner` is within `outer` (1px rounding slack). */
async function expectInside(outer: Locator, inner: Locator): Promise<void> {
  const o = await outer.boundingBox()
  const i = await inner.boundingBox()
  expect(o).not.toBeNull()
  expect(i).not.toBeNull()
  if (!o || !i) return
  expect(i.x).toBeGreaterThanOrEqual(o.x - 1)
  expect(i.x + i.width).toBeLessThanOrEqual(o.x + o.width + 1)
}

async function cleanup(page: Page, id: string): Promise<void> {
  try {
    await page.request.post(`/api/v1/content/${id}/unpublish`, {
      data: { destination: 'intranet' },
    })
    await page.request.delete(`/api/v1/content/${id}`)
  } catch {
    // Teardown must never mask the real assertion failure.
  }
}

test.describe('Atrium share dialog + Live follows the latest save', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )
  test.describe.configure({ timeout: 180_000 })
  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true })
  })

  test('the Share dialog keeps every row inside the box, and a save to a Live page reaches /c/{slug} without Republish', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const page = await context.newPage()
    const token = runToken()
    // A deliberately long title → a long slug → a long reader URL, the input
    // that used to widen the dialog's grid column.
    const title = `Building level program expenditures fiscal year twenty six share dialog ${token}`
    const res = await page.request.post('/api/v1/content', {
      data: {
        kind: 'document',
        title,
        body: `# ${title}\n\nOLD-CONTENT-${token}`,
        bodyFormat: 'markdown',
        visibility: { level: 'group', grants: [{ kind: 'role', value: 'student' }] },
      },
    })
    expect(res.status()).toBe(201)
    const { id, slug } = (await res.json()).data as { id: string; slug: string }

    try {
      await page.goto(`/atrium/${id}/edit`)
      await page.getByTestId('share-control').click()
      const publish = page.getByTestId('share-publish')
      await expect(publish).toBeEnabled({ timeout: 60000 })
      await publish.click()
      await expect(page.getByTestId('share-live-state')).toHaveAttribute(
        'data-live',
        'true',
        { timeout: 60000 }
      )

      const dialog = page.getByRole('dialog')
      const rows = [
        page.getByTestId('share-link-url'),
        page.getByLabel('Level'),
        page.getByTestId('share-live-state'),
        page.getByTestId('share-connector-schoology'),
        page.getByRole('button', { name: 'Save', exact: true }),
      ]
      for (const row of rows) await expectInside(dialog, row)
      await page.screenshot({ path: `${SHOT_DIR}/atrium-share-dialog-desktop.png` })

      await page.setViewportSize({ width: 375, height: 812 })
      for (const row of rows) await expectInside(dialog, row)
      await page.screenshot({ path: `${SHOT_DIR}/atrium-share-dialog-mobile.png` })
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.keyboard.press('Escape')

      // Live serves the published version.
      await page.goto(`/c/${slug}`)
      await expect(page.getByText(`OLD-CONTENT-${token}`)).toBeVisible({ timeout: 60000 })

      // Save a new version — NO Republish.
      const saved = await page.request.post(`/api/v1/content/${id}/versions`, {
        data: { body: `# ${title}\n\nNEW-CONTENT-${token}`, bodyFormat: 'markdown' },
      })
      expect([200, 201]).toContain(saved.status())

      await page.goto(`/c/${slug}`)
      await expect(page.getByText(`NEW-CONTENT-${token}`)).toBeVisible({ timeout: 60000 })
      await expect(page.getByText(`OLD-CONTENT-${token}`)).toHaveCount(0)
      await expect(page.getByTestId('reader-uptodate')).toBeVisible()
      await page.screenshot({ path: `${SHOT_DIR}/atrium-reader-live-follows-save.png` })
    } finally {
      await cleanup(page, id)
      await context.close()
    }
  })
})
