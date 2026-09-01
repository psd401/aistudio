import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'
import { mkdirSync } from 'node:fs'

/**
 * E2E functional coverage for the Favorites and Unfiled library VIEW chips.
 *
 * Regression guard: `useLibraryPage` destructured every `ListFilter` field
 * EXCEPT `filed` and `favorite`, so both chips fetched the unfiltered "All
 * content" grid — and because the two fields were also missing from the
 * `fetchPage` dependency array, switching chips did not even refetch. The grid
 * looked correct (no error, cards rendered), which is exactly why only an
 * assertion that a NON-matching card is absent can catch it:
 *
 *  - FAVORITES (B1). Seed two docs, star one, switch to the Favorites chip:
 *    the starred doc must remain and the unstarred one must LEAVE the grid.
 *    The chip toggles `favorite` with every other filter unchanged, so this
 *    also proves the dependency-array half (no other dep changes to mask a
 *    missing refetch).
 *  - UNFILED (B2). Seed one doc inside a collection and one loose, enter the
 *    Unfiled view via the home band's "See all unfiled" (the same
 *    `useSeeAllHandler` path the bug report named): the loose doc must remain
 *    and the FILED one must leave.
 *
 * Auth: mints a NextAuth session cookie for the seeded admin
 * (helpers/session-auth). Requires AUTH_SECRET and the host :3100 dev server —
 * see docs/guides/e2e-authenticated-testing.md. Gated behind
 * PLAYWRIGHT_AUTH_ENABLED so default CI (no seeded session) skips.
 */

const SHOT_DIR = '.verification'

/** Unique-per-run token so seeded rows never collide across runs or workers. */
function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

/**
 * Best-effort teardown for the drafts a spec created (leaving rows behind slows
 * every other library spec — they page through the same list). Failures are
 * ignored so teardown can never mask the real assertion failure.
 */
async function cleanup(
  page: import('@playwright/test').Page,
  ids: string[]
): Promise<void> {
  for (const id of ids) {
    try {
      await page.request.delete(`/api/v1/content/${id}`)
    } catch {
      // Ignored on purpose — see the docblock.
    }
  }
}

function searchBox(page: import('@playwright/test').Page) {
  return page.getByRole('textbox', { name: 'Search content by title or tag' })
}

function chips(page: import('@playwright/test').Page) {
  return page.getByRole('group', { name: 'Filter content' })
}

/**
 * Wait until the grid has COMMITTED a fetch for `query` — `data-results-query`
 * is set in the same state batch as the items (see the settled-state note in
 * `useLibraryPage`), so a passing wait means the grid on screen was fetched
 * with the CURRENT view's full filter set, debounce included.
 */
async function awaitResultsFor(
  page: import('@playwright/test').Page,
  query: string
) {
  await expect(
    page.locator(`section[data-results-query="${query}"]`)
  ).toBeVisible({ timeout: 15000 })
}

test.describe('Atrium library view filters — Favorites & Unfiled chips (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  // Several server actions compile on first hit against the dev server, so the
  // default 60s per-test budget is too tight (same as the polish suite).
  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true })
  })

  test('atrium-library-favorites-chip: the Favorites chip narrows the grid to starred content and All content restores it', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    try {
      const page = await context.newPage()
      const token = runToken()
      const tag = `favchip${token}`

      // Two drafts isolated by a unique tag: one will be starred, the other is
      // the card whose DISAPPEARANCE is the actual regression assertion.
      const ids: string[] = []
      for (const name of ['Starred', 'Plain']) {
        const res = await page.request.post('/api/v1/content', {
          data: {
            kind: 'document',
            title: `${name} probe ${token}`,
            body: '# hi',
            bodyFormat: 'markdown',
            tags: [tag],
          },
        })
        expect(res.status()).toBe(201)
        ids.push((await res.json())?.data?.id as string)
      }
      const [starredId, plainId] = ids
      const starredCard = page.locator(`a[href="/atrium/${starredId}/edit"]`)
      const plainCard = page.locator(`a[href="/atrium/${plainId}/edit"]`)

      await page.goto('/atrium')
      await searchBox(page).fill(tag)
      await awaitResultsFor(page, tag)
      await expect(starredCard).toBeVisible()
      await expect(plainCard).toBeVisible()

      // Star one doc and wait for the write to be DURABLE, not just optimistic:
      // `aria-pressed` flips in the same commit as `data-busy="true"`, so once
      // pressed is observed, busy returning to "false" means the server action
      // resolved (and pressed still being true means it succeeded). Switching
      // views before this could refetch ahead of the favorite row committing.
      const star = page.getByTestId(`favorite-${starredId}`)
      await star.click()
      await expect(star).toHaveAttribute('aria-pressed', 'true')
      await expect(star).toHaveAttribute('data-busy', 'false')
      await expect(star).toHaveAttribute('aria-pressed', 'true')

      // The Favorites chip: the starred doc stays, the plain one must LEAVE.
      // Before the fix this changed nothing (no refetch, `favorite` never sent),
      // so the plain card lingering is the regression signal.
      const favoritesChip = chips(page).getByRole('button', {
        name: 'Favorites',
        exact: true,
      })
      await favoritesChip.click()
      await expect(favoritesChip).toHaveAttribute('aria-pressed', 'true')
      await expect(starredCard).toBeVisible({ timeout: 15000 })
      await expect(plainCard).toHaveCount(0, { timeout: 15000 })

      await page.screenshot({
        path: `${SHOT_DIR}/atrium-library-favorites-chip.png`,
        fullPage: false,
      })

      // And back: All content must refetch WITHOUT the favorite restriction.
      await chips(page)
        .getByRole('button', { name: 'All content', exact: true })
        .click()
      await expect(starredCard).toBeVisible({ timeout: 15000 })
      await expect(plainCard).toBeVisible({ timeout: 15000 })

      await cleanup(page, ids)
    } finally {
      await context.close()
    }
  })

  test('atrium-library-unfiled-chip: "See all unfiled" narrows the grid to content outside every collection', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    try {
      const page = await context.newPage()
      const token = runToken()
      const tag = `unfchip${token}`

      // A private collection to file one probe into (private keeps the shared
      // sections sidebar clean for unrelated specs).
      const coll = await page.request.post('/api/v1/content/collections', {
        data: { name: `Filing cabinet ${token}`, scope: 'private' },
      })
      expect(coll.status()).toBe(201)
      const collectionId = (await coll.json())?.data?.id as string
      expect(collectionId).toBeTruthy()

      const filed = await page.request.post('/api/v1/content', {
        data: {
          kind: 'document',
          title: `Filed probe ${token}`,
          body: '# filed',
          bodyFormat: 'markdown',
          tags: [tag],
          collectionId,
        },
      })
      expect(filed.status()).toBe(201)
      const filedId = (await filed.json())?.data?.id as string

      const loose = await page.request.post('/api/v1/content', {
        data: {
          kind: 'document',
          title: `Loose probe ${token}`,
          body: '# loose',
          bodyFormat: 'markdown',
          tags: [tag],
        },
      })
      expect(loose.status()).toBe(201)
      const looseId = (await loose.json())?.data?.id as string

      // Enter the Unfiled view the way a person does — the home band's
      // "See all unfiled" (useSeeAllHandler), which also proves the chip row
      // adds the active non-primary chip back.
      await page.goto('/atrium')
      await page.getByRole('button', { name: 'See all unfiled' }).click()
      await expect(
        chips(page).getByRole('button', { name: 'Unfiled', exact: true })
      ).toHaveAttribute('aria-pressed', 'true')

      // Narrow to this run's probes. `data-results-query` commits atomically
      // with the items, so after this wait the grid was fetched with the
      // CURRENT (unfiled) view's filters — no settled signal exists for `filed`
      // itself.
      await searchBox(page).fill(tag)
      await awaitResultsFor(page, tag)

      // The loose doc stays; the FILED one must be excluded. Before the fix the
      // `filed` restriction was silently dropped from the fetch, so both
      // rendered.
      await expect(
        page.locator(`a[href="/atrium/${looseId}/edit"]`)
      ).toBeVisible({ timeout: 15000 })
      await expect(
        page.locator(`a[href="/atrium/${filedId}/edit"]`)
      ).toHaveCount(0, { timeout: 15000 })

      await page.screenshot({
        path: `${SHOT_DIR}/atrium-library-unfiled-chip.png`,
        fullPage: false,
      })

      await cleanup(page, [filedId, looseId])
      // Best-effort: archive the scratch collection so it does not accumulate
      // in the seeded admin's private tree across runs.
      try {
        await page.request.patch(`/api/v1/content/collections/${collectionId}`, {
          data: { archived: true },
        })
      } catch {
        // Ignored — teardown must never mask the real assertion failure.
      }
    } finally {
      await context.close()
    }
  })
})
