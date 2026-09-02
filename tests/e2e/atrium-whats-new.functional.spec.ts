import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'
import { mkdirSync } from 'node:fs'

/**
 * E2E functional coverage for the library's district-wide "What's new".
 *
 * Before this, the only recency the library offered was "Your recent work" on
 * Home (owner-scoped) and the fixed newest-first ordering of whatever view
 * you were in. There was no way to ask "what has anyone changed lately".
 *
 *  - Home gets a "New across the district" band (everything the viewer can
 *    see, anyone's, touched in the last 7 days); a freshly seeded document
 *    appears in it without any filter.
 *  - "See everything new" switches to the new "What's new" chip view, which
 *    is the full grid filtered by the server `since` (updated_at) and labelled
 *    as such; the seeded document is in it.
 *
 * Auth: minted session for the seeded admin. Gated behind PLAYWRIGHT_AUTH_ENABLED.
 */

const SHOT_DIR = 'docs/verification/atrium-whats-new'

function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

test.describe('Atrium "What\'s new" (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true })
  })

  test('a just-created document shows in the district band and in the What\'s new view', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const page = await context.newPage()
    const title = `Whats new probe ${runToken()}`
    const created: string[] = []
    try {
      const res = await page.request.post('/api/v1/content', {
        data: {
          kind: 'document',
          title,
          body: `# ${title}\n\nTouched just now.`,
          bodyFormat: 'markdown',
          visibility: { level: 'private' },
        },
      })
      expect(res.status()).toBe(201)
      created.push((await res.json()).data.id as string)

      // 1. Home: the district-wide band exists and contains the new doc.
      await page.goto('/atrium')
      const band = page.getByTestId('home-band-whats-new')
      await expect(band).toBeVisible({ timeout: 60000 })
      await expect(band.getByText(title, { exact: true })).toBeVisible({ timeout: 60000 })
      await page.screenshot({ path: `${SHOT_DIR}/01-home-district-band.png`, fullPage: true })

      // 2. "See everything new" → the What's new chip view, labelled, with the doc.
      await band.getByRole('button', { name: 'See everything new' }).click()
      const chip = page
        .getByRole('group', { name: 'Filter content' })
        .getByRole('button', { name: "What's new", exact: true })
      await expect(chip).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('library-sort-label')).toContainText('Updated in the last')
      await expect(page.getByText(title, { exact: true })).toBeVisible({ timeout: 60000 })
      await page.screenshot({ path: `${SHOT_DIR}/02-whats-new-view.png`, fullPage: false })

      // 3. The chip is reachable directly from the default bar too.
      await page.goto('/atrium')
      await expect(
        page
          .getByRole('group', { name: 'Filter content' })
          .getByRole('button', { name: "What's new", exact: true })
      ).toBeVisible()
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
})
