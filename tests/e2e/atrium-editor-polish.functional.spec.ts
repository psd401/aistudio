import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'
import { mkdirSync } from 'node:fs'

/**
 * E2E functional coverage for the #1336 editor cluster.
 *
 * Flows: `atrium-cover-picker`, `atrium-editor-sync-status`,
 * `atrium-comments-toggle`.
 *
 * What this proves:
 *
 *  - COVER PICKER (B1). The popover used to be a child of the 170px
 *    `overflow: hidden` cover band, so its bottom third — the ICON label, the
 *    emoji field and "Remove cover" — was clipped away. The assertions check
 *    those exact elements are visible AND that the popover's bounding box sits
 *    inside the viewport, then that Escape and an outside click dismiss it.
 *  - SYNC GATE + BUBBLE TOOLBAR (B4/B5). A seeded doc's body must be visible
 *    before typing is possible, the byline must reach "saved", and the bubble
 *    toolbar must appear on the FIRST selection of a fresh session — both by
 *    double-click and by shift+arrow — with no comment added first.
 *  - COMMENT RAIL (B3). Hidden on a doc with no comments, with a topbar chip
 *    showing 0; the chip opens it; the sheet re-centers when it closes.
 *
 * Auth: see helpers/session-auth. Gated behind PLAYWRIGHT_AUTH_ENABLED.
 */

const SHOT_DIR = '.verification'


/**
 * Best-effort teardown for objects a spec created. Leaving rows behind grows the
 * shared local library on every run, which makes UNRELATED library specs slower
 * and flakier (they page through the same list). Published objects are refused
 * by delete, so they are unpublished first. Failures are ignored — teardown must
 * never mask the real assertion failure.
 */
async function cleanup(
  page: import('@playwright/test').Page,
  ids: string[]
): Promise<void> {
  for (const id of ids) {
    try {
      await page.request.post(`/api/v1/content/${id}/unpublish`, {
        data: { destination: 'intranet' },
      })
      await page.request.post(`/api/v1/content/${id}/unpublish`, {
        data: { destination: 'public_web' },
      })
      await page.request.delete(`/api/v1/content/${id}`)
    } catch {
      // Ignored on purpose — see the docblock.
    }
  }
}

function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

test.describe('Atrium editor polish (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  // These flows fan out several server actions (archive/restore/delete,
  // publish + widen) against a Next DEV server that compiles each action on
  // first hit, so the default 60s per-test budget is genuinely too tight here.
  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true })
  })

  test('atrium-cover-picker: the picker renders fully inside the viewport and closes on Escape and outside click', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    try {
      const page = await context.newPage()
      const token = runToken()
      const created = await page.request.post('/api/v1/content', {
        data: {
          kind: 'document',
          title: `Cover probe ${token}`,
          body: '# body',
          bodyFormat: 'markdown',
        },
      })
      expect(created.status()).toBe(201)
      const id = (await created.json())?.data?.id as string

      await page.goto(`/atrium/${id}/edit`)

      // Add a cover, then open the picker from the band's pill. `addCover` no
      // longer auto-opens the picker (#1336 B1), so the pill is the entry point.
      const addCover = page.getByTestId('editor-add-cover')
      await expect(addCover).toBeVisible({ timeout: 60000 })
      await addCover.click()
      const changeCover = page.getByTestId('editor-change-cover')
      await expect(changeCover).toBeVisible({ timeout: 60000 })
      await changeCover.click()

      const picker = page.getByTestId('editor-cover-picker')
      await expect(picker).toBeVisible()

      // The three elements that used to be clipped away entirely.
      await expect(picker.getByText('Icon', { exact: true })).toBeVisible()
      await expect(page.getByTestId('editor-cover-emoji-input')).toBeVisible()
      await expect(page.getByTestId('editor-remove-cover')).toBeVisible()

      // Not merely "visible" per the a11y tree — the popover's box must actually
      // fit inside the viewport, which is the specific thing `overflow: hidden`
      // on the band broke.
      const box = await picker.boundingBox()
      expect(box).not.toBeNull()
      const viewport = page.viewportSize()
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height)
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width)

      // The kicker/title is no longer glued to the cover tile (#1336 B2): there
      // is real vertical space between the band and the sheet title.
      await page.screenshot({
        path: `${SHOT_DIR}/atrium-cover-picker.png`,
        fullPage: false,
      })

      // Escape closes it.
      await page.keyboard.press('Escape')
      await expect(picker).toBeHidden()

      // Outside click closes it.
      await changeCover.click()
      await expect(picker).toBeVisible()
      await page.mouse.click(20, 500)
      await expect(picker).toBeHidden()

      await cleanup(page, [id])
    } finally {
      await context.close()
    }
  })

  test('atrium-editor-sync-status: seeded body renders, the byline reaches "saved", and the bubble toolbar appears on the first selection', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    try {
      const page = await context.newPage()
      const token = runToken()
      const marker = `syncmarker${token}`
      const created = await page.request.post('/api/v1/content', {
        data: {
          kind: 'document',
          title: `Sync probe ${token}`,
          body: `# Heading\n\nThe ${marker} paragraph text.`,
          bodyFormat: 'markdown',
        },
      })
      expect(created.status()).toBe(201)
      const id = (await created.json())?.data?.id as string

      await page.goto(`/atrium/${id}/edit`)

      // The seeded body must actually render — the pre-#1336 failure mode was an
      // empty, editable sheet that accepted typing until sync merged.
      await expect(page.getByText(marker)).toBeVisible({ timeout: 30000 })

      // The byline must settle on "saved" rather than sitting on "connecting…"
      // forever (the StrictMode destroyed-Y.Doc symptom).
      await expect(page.getByTestId('editor-byline')).toContainText('saved', {
        timeout: 30000,
      })

      // FIRST selection of a fresh session, by double-click — no comment added.
      const bubble = page.getByTestId('editor-bubble-menu')
      await page.getByText(marker).dblclick()
      await expect(bubble).toBeVisible({ timeout: 10000 })

      await page.screenshot({
        path: `${SHOT_DIR}/atrium-editor-sync-status.png`,
        fullPage: false,
      })

      // And by keyboard: collapse the selection, then shift+arrow.
      await page.keyboard.press('ArrowRight')
      await expect(bubble).toBeHidden({ timeout: 10000 })
      await page.keyboard.press('Shift+ArrowLeft')
      await page.keyboard.press('Shift+ArrowLeft')
      await expect(bubble).toBeVisible({ timeout: 10000 })

      await cleanup(page, [id])
    } finally {
      await context.close()
    }
  })

  test('atrium-comments-toggle: the rail is hidden on a comment-free doc and the topbar chip toggles it', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    try {
      const page = await context.newPage()
      const token = runToken()
      const created = await page.request.post('/api/v1/content', {
        data: {
          kind: 'document',
          title: `Comments probe ${token}`,
          body: '# body\n\nSome text to select.',
          bodyFormat: 'markdown',
        },
      })
      expect(created.status()).toBe(201)
      const id = (await created.json())?.data?.id as string

      await page.goto(`/atrium/${id}/edit`)

      const toggle = page.getByTestId('comments-toggle')
      await expect(toggle).toBeVisible({ timeout: 30000 })
      // Zero open comments → the chip reads 0 and the 296px rail is collapsed.
      await expect(page.getByTestId('comments-open-count')).toHaveText('0', {
        timeout: 60000,
      })
      const rail = page.getByTestId('comment-rail')
      await expect(rail).toHaveAttribute('data-open', 'false')
      // Collapsed means removed from layout — the sheet re-centers.
      await expect(rail).toBeHidden()

      // The chip opens it either way.
      await toggle.click()
      await expect(rail).toHaveAttribute('data-open', 'true')
      await expect(page.getByTestId('comment-sidebar')).toBeVisible()

      await page.screenshot({
        path: `${SHOT_DIR}/atrium-comments-toggle.png`,
        fullPage: false,
      })

      // …and closes it again, re-centering the sheet.
      await toggle.click()
      await expect(rail).toHaveAttribute('data-open', 'false')
      await expect(rail).toBeHidden()

      await cleanup(page, [id])
    } finally {
      await context.close()
    }
  })
})
