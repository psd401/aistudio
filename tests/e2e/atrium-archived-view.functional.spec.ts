import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'
import { mkdirSync } from 'node:fs'

/**
 * E2E functional coverage for the Atrium "Archived" library view (Epic #1059
 * follow-up).
 *
 * The gap this closes: archived content vanishes from the default library (the
 * service excludes `status = 'archived'` from every non-archived list) and, until
 * now, could only be found via the API/skill. This proves the UI path end-to-end:
 *
 *  - The "Archived" filter chip is the ONLY view that surfaces archived content;
 *    the default view still excludes it (no regression).
 *  - An archived card renders muted (`mer-card-archived`) with an ARCHIVED pill.
 *  - The full lifecycle from the UI: archive → appears ONLY under Archived →
 *    restore returns it to the default view → archive again → Delete permanently
 *    → gone from every view, and the editor route 404s.
 *  - The "Nothing archived" empty state.
 *
 * Auth: mints a NextAuth session cookie for the seeded admin (helpers/session-auth).
 * Requires AUTH_SECRET in env and the host :3100 dev server (NOT the prod-built
 * :3000 container, which rejects the non-secure dev cookie). See
 * docs/guides/e2e-authenticated-testing.md. Gated behind PLAYWRIGHT_AUTH_ENABLED so
 * default CI (no seeded session) skips.
 */

const SHOT_DIR = 'docs/verification/atrium-meridian'

/** The chips group's "Archived" filter button. */
function archivedChip(page: import('@playwright/test').Page) {
  return page
    .getByRole('group', { name: 'Filter content' })
    .getByRole('button', { name: 'Archived', exact: true })
}

test.describe('Atrium archived-content view (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true })
  })

  test('the "Archived" filter shows a deterministic empty state', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context)
    try {
      const page = await context.newPage()
      await page.goto('/atrium')

      // Select "Archived", then pin an impossible tag so the archived result set
      // is deterministically empty regardless of any archived seed data — the
      // exact same empty-state component the zero-archived case renders.
      await archivedChip(page).click()
      await expect(archivedChip(page)).toHaveAttribute('aria-pressed', 'true')
      await page
        .getByRole('textbox', { name: 'Filter by tag' })
        .fill('no-such-tag-zzz-e2e')

      await expect(page.getByText('Nothing archived')).toBeVisible({
        timeout: 15000,
      })
      // The create affordance is suppressed in the archived management view.
      await expect(
        page.getByRole('button', { name: /Create with the agent/i })
      ).toHaveCount(0)

      await page.screenshot({
        path: `${SHOT_DIR}/11-archived-empty.png`,
        fullPage: false,
      })
    } finally {
      await context.close()
    }
  })

  test('archive → archived-only view (muted + pill) → restore → archive → delete → 404', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    try {
      const page = await context.newPage()
      // Archive + delete both raise a window.confirm — auto-accept every dialog.
      page.on('dialog', (dialog) => void dialog.accept())

      // A doc with a unique title so its card link is unambiguous across views.
      const title = `e2e archived probe ${Date.now()}`
      const created = await page.request.post('/api/v1/content', {
        data: { kind: 'document', title, body: '# hi', bodyFormat: 'markdown' },
      })
      expect(created.status()).toBe(201)
      const id = (await created.json())?.data?.id as string
      expect(id).toBeTruthy()
      const cardLink = page.locator(`a[href="/atrium/${id}/edit"]`)

      // It starts as a draft: visible in the default library, absent from Archived.
      await page.goto('/atrium')
      await expect(cardLink).toBeVisible({ timeout: 15000 })
      await archivedChip(page).click()
      await expect(cardLink).toHaveCount(0)

      // Archive it from the editor's content-settings dialog.
      await page.goto(`/atrium/${id}/edit`)
      const gear = page.getByRole('button', { name: 'Content settings' })
      await expect(gear).toBeVisible({ timeout: 15000 })
      await gear.click()
      await page.getByRole('button', { name: 'Archive', exact: true }).click()
      // Archiving navigates back to the library.
      await page.waitForURL('**/atrium', { timeout: 15000 })

      // Now it is GONE from the default view and present ONLY under Archived.
      await expect(cardLink).toHaveCount(0)
      await archivedChip(page).click()
      await expect(cardLink).toBeVisible({ timeout: 15000 })
      // Muted treatment + ARCHIVED pill on the card.
      await expect(cardLink).toHaveClass(/mer-card-archived/)
      await expect(cardLink.getByText('Archived', { exact: true })).toBeVisible()

      await page.screenshot({
        path: `${SHOT_DIR}/11-archived-library.png`,
        fullPage: false,
      })

      // The card is a working link — click it through to the editor and Restore.
      await cardLink.click()
      await page.waitForURL(`**/atrium/${id}/edit`, { timeout: 15000 })
      await page.getByRole('button', { name: 'Content settings' }).click()
      await page.getByRole('button', { name: 'Restore', exact: true }).click()
      // Restore closes the settings dialog and refreshes in place (it does NOT
      // navigate). The dialog only closes AFTER the status write succeeds, so
      // waiting for the Restore control to detach confirms the restore committed
      // before we re-check the library.
      await expect(
        page.getByRole('button', { name: 'Restore', exact: true })
      ).toBeHidden({ timeout: 15000 })

      // Back in the library it is visible in the default view again, absent from Archived.
      await page.goto('/atrium')
      await expect(cardLink).toBeVisible({ timeout: 15000 })
      await archivedChip(page).click()
      await expect(cardLink).toHaveCount(0)

      // Archive it a second time, then Delete permanently from the editor.
      await page.goto(`/atrium/${id}/edit`)
      await page.getByRole('button', { name: 'Content settings' }).click()
      await page.getByRole('button', { name: 'Archive', exact: true }).click()
      await page.waitForURL('**/atrium', { timeout: 15000 })

      await archivedChip(page).click()
      await expect(cardLink).toBeVisible({ timeout: 15000 })
      await cardLink.click()
      await page.waitForURL(`**/atrium/${id}/edit`, { timeout: 15000 })
      await page.getByRole('button', { name: 'Content settings' }).click()
      await page.getByRole('button', { name: 'Delete permanently' }).click()
      await page.waitForURL('**/atrium', { timeout: 15000 })

      // Gone from every view: the API 404s, the editor route 404s, and the card
      // is absent from both the default and Archived lists.
      const readAfter = await page.request.get(`/api/v1/content/${id}`)
      expect(readAfter.status()).toBe(404)

      const editorResp = await page.goto(`/atrium/${id}/edit`)
      expect(editorResp?.status()).toBe(404)

      await page.goto('/atrium')
      await expect(cardLink).toHaveCount(0)
      await archivedChip(page).click()
      await expect(cardLink).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
})
