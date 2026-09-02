import { test, expect, type Page } from './fixtures'
import type { Route } from '@playwright/test'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
  SEEDED_STAFF_EMAIL,
  SEEDED_STAFF_SUB,
} from './helpers/session-auth'

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
 *    Then unstar it INSIDE the view (it must leave at once), restore All
 *    content, and force the chip's refetch to fail (the error state must show
 *    instead of stale cards or a dangling "Load more").
 *  - UNFILED (B2). Seed one doc inside a collection, one loose, and one loose
 *    doc owned by ANOTHER user; enter the Unfiled view via the home band's
 *    "See all unfiled" (the same `useSeeAllHandler` path the bug report named).
 *    The band is "Not in a section yet" — the caller's OWN unfiled work — so
 *    "See all" must open that list: owner select on "Mine", the loose doc
 *    stays, the FILED one and the OTHER user's leave; widening the owner
 *    select to "Anyone" brings the other user's back. Also covered: opening
 *    the page with a legacy `?collection=` scope, which "unfiled" must drop
 *    rather than AND into an empty-by-construction grid.
 *
 * Every wait on the grid goes through `data-results-key`, which the hook sets
 * in the same state batch as the items: the loading spinner unmounts every
 * card, so "the other card is gone" on its own would be satisfiable mid-fetch.
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
 * Create one tagged draft doc through the REST API and return its id. The
 * titles ("<Name> probe <token>") are listed in scripts/db/cleanup-e2e-content.ts
 * so `bun run db:cleanup:e2e` can prune anything a crashed run leaves behind.
 */
async function seedDoc(
  request: Page['request'],
  opts: { title: string; tag: string; collectionId?: string }
): Promise<string> {
  const res = await request.post('/api/v1/content', {
    data: {
      kind: 'document',
      title: opts.title,
      body: '# probe',
      bodyFormat: 'markdown',
      tags: [opts.tag],
      ...(opts.collectionId ? { collectionId: opts.collectionId } : {}),
    },
  })
  expect(res.status()).toBe(201)
  const id = (await res.json())?.data?.id as string | undefined
  expect(id).toBeTruthy()
  return id as string
}

/**
 * Best-effort teardown, run from `finally` so a FAILED assertion still removes
 * what the test seeded: rows left behind slow every other library spec, and a
 * leftover starred probe would surface in the Home Favorites band on every
 * later run. Failures are swallowed so teardown can never mask the real
 * failure. Takes the request context (not the page) so it works after a
 * mid-test throw; ids are pushed as they are created so a seeding failure
 * still cleans up whatever landed.
 */
async function cleanup(
  request: Page['request'],
  ids: readonly string[],
  collectionId?: string
): Promise<void> {
  for (const id of ids) {
    try {
      await request.delete(`/api/v1/content/${id}`)
    } catch {
      // Ignored on purpose — see the docblock.
    }
  }
  if (collectionId) {
    try {
      await request.patch(`/api/v1/content/collections/${collectionId}`, {
        data: { archived: true },
      })
    } catch {
      // Ignored on purpose — see the docblock.
    }
  }
}

function searchBox(page: Page) {
  return page.getByRole('textbox', { name: 'Search content by title or tag' })
}

function chips(page: Page) {
  return page.getByRole('group', { name: 'Filter content' })
}

function card(page: Page, id: string) {
  return page.locator(`a[href="/atrium/${id}/edit"]`)
}

/**
 * Wait until the grid has COMMITTED a fetch for `query` — `data-results-query`
 * is set in the same state batch as the items (see the settled-state note in
 * `useLibraryPage`), so the debounced search cannot race it.
 */
async function awaitResultsFor(page: Page, query: string) {
  await expect(
    page.locator(`section[data-results-query="${query}"]`)
  ).toBeVisible({ timeout: 15000 })
}

/**
 * Wait until the on-screen result was fetched with a filter whose serialized
 * form matches `pattern`. This is the barrier for a VIEW change: the query does
 * not change when a chip is clicked, so `data-results-query` cannot express
 * it, and the loading spinner unmounts every card, so a bare `toHaveCount(0)`
 * on the excluded card would be satisfiable before the refetch even returns.
 * Also set on a FAILED fetch (the error is what is on screen for this filter).
 */
async function awaitSettledKey(page: Page, pattern: RegExp) {
  await expect(page.locator('section[data-results-key]')).toHaveAttribute(
    'data-results-key',
    pattern,
    { timeout: 15000 }
  )
}

/**
 * Wait for a star write to be DURABLE, not just optimistic: `aria-pressed`
 * flips in the same commit as `data-busy="true"`, so once the expected pressed
 * state is observed, busy returning to "false" means the server action
 * resolved. The trailing pressed check is the only direct "write succeeded"
 * assertion — busy returns to "false" on the FAILURE commit too, where the
 * star reverts — and it turns a failed write into a clear message here rather
 * than a confusing timeout further down.
 */
async function awaitStarSettled(
  star: ReturnType<Page['getByTestId']>,
  pressed: 'true' | 'false'
) {
  await expect(star).toHaveAttribute('aria-pressed', pressed)
  await expect(star).toHaveAttribute('data-busy', 'false')
  await expect(star).toHaveAttribute('aria-pressed', pressed)
}

const isAtriumPage = (url: URL) => url.pathname === '/atrium'

// Each test is registered from its own function (the convention the polish
// spec uses) so the describe callback stays under the max-lines lint.
function defineFavoritesChipTest() {
  test('atrium-library-favorites-chip: the Favorites chip narrows the grid to starred content, an unstar leaves it at once, All content restores it, and a failed refetch shows the error state', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const ids: string[] = []
    try {
      const page = await context.newPage()
      const token = runToken()
      const tag = `favchip${token}`

      // Two drafts isolated by a unique tag: one will be starred, the other is
      // the card whose DISAPPEARANCE is the actual regression assertion.
      const starredId = await seedDoc(page.request, {
        title: `Starred probe ${token}`,
        tag,
      })
      ids.push(starredId)
      const plainId = await seedDoc(page.request, {
        title: `Plain probe ${token}`,
        tag,
      })
      ids.push(plainId)
      const starredCard = card(page, starredId)
      const plainCard = card(page, plainId)

      await page.goto('/atrium')
      await searchBox(page).fill(tag)
      await awaitResultsFor(page, tag)
      await expect(starredCard).toBeVisible()
      await expect(plainCard).toBeVisible()

      // Star one doc; switching views before the write is durable could refetch
      // ahead of the favorite row committing.
      const star = page.getByTestId(`favorite-${starredId}`)
      await star.click()
      await awaitStarSettled(star, 'true')

      // The Favorites chip: the starred doc stays, the plain one must LEAVE.
      // Before the fix this changed nothing (no refetch, `favorite` never
      // sent), so the plain card lingering is the regression signal.
      const favoritesChip = chips(page).getByRole('button', {
        name: 'Favorites',
        exact: true,
      })
      await favoritesChip.click()
      await expect(favoritesChip).toHaveAttribute('aria-pressed', 'true')
      await awaitSettledKey(page, /"favorite":true/)
      await expect(starredCard).toBeVisible()
      await expect(plainCard).toHaveCount(0)

      await page.screenshot({
        path: `${SHOT_DIR}/atrium-library-favorites-chip.png`,
      })

      // Unstarring INSIDE the Favorites view drops the card at once: it no
      // longer matches the grid's own filter (a local removal, no refetch). A
      // failed write reverts the star and the card stays, so this also proves
      // the write. The star unmounts with the card, so the card is the signal.
      await star.click()
      await expect(starredCard).toHaveCount(0)

      // And back: All content must refetch WITHOUT the favorite restriction.
      await chips(page)
        .getByRole('button', { name: 'All content', exact: true })
        .click()
      await expect(page.locator('section[data-results-key]')).not.toHaveAttribute(
        'data-results-key',
        /"favorite"/,
        { timeout: 15000 }
      )
      await expect(starredCard).toBeVisible()
      await expect(plainCard).toBeVisible()

      // ERROR STATE: make the chip's refetch fail exactly once by aborting the
      // server-action POST (the page URL with a `next-action` header). The grid
      // must report it — no stale cards, no dangling "Load more". Installed
      // only now, so no earlier write was ever intercepted; `page.request`
      // calls (teardown) bypass page routes anyway.
      let aborted = false
      const abortOnce = async (route: Route): Promise<void> => {
        const req = route.request()
        if (
          !aborted &&
          req.method() === 'POST' &&
          req.headers()['next-action'] !== undefined
        ) {
          aborted = true
          await route.abort('failed')
          return
        }
        await route.continue()
      }
      await page.route(isAtriumPage, abortOnce)
      await favoritesChip.click()
      await awaitSettledKey(page, /"favorite":true/)
      // Scoped to the library section: Next's route announcer is a page-level
      // role="alert" too.
      await expect(
        page.locator('section[data-results-key]').getByRole('alert')
      ).toHaveText('Could not load content')
      await expect(starredCard).toHaveCount(0)
      await expect(plainCard).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
      await page.unroute(isAtriumPage, abortOnce)

      await page.screenshot({
        path: `${SHOT_DIR}/atrium-library-favorites-chip-error.png`,
      })
    } finally {
      await cleanup(context.request, ids)
      await context.close()
    }
  })
}

function defineUnfiledChipTest() {
  test('atrium-library-unfiled-chip: "See all unfiled" narrows the grid to the caller\'s own content outside every collection, widens on request, and drops a ?collection= scope instead of ANDing it', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    // A second person: their unfiled doc is visible to the admin, so only the
    // owner scope can exclude it.
    const staff = await browser.newContext()
    await authenticateContext(staff, SEEDED_STAFF_EMAIL, SEEDED_STAFF_SUB)
    const ids: string[] = []
    let collectionId: string | undefined
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
      collectionId = (await coll.json())?.data?.id as string | undefined
      expect(collectionId).toBeTruthy()

      const filedId = await seedDoc(page.request, {
        title: `Filed probe ${token}`,
        tag,
        collectionId,
      })
      ids.push(filedId)
      const looseId = await seedDoc(page.request, {
        title: `Loose probe ${token}`,
        tag,
      })
      ids.push(looseId)
      const theirsId = await seedDoc(staff.request, {
        title: `Theirs probe ${token}`,
        tag,
      })
      ids.push(theirsId)
      const looseCard = card(page, looseId)
      const filedCard = card(page, filedId)
      const theirsCard = card(page, theirsId)
      const ownerSelect = page.getByTestId('library-owner-filter')

      // Enter the Unfiled view the way a person does — the home band's
      // "See all unfiled" (useSeeAllHandler), which also proves the chip row
      // adds the active non-primary chip back. The band is the caller's OWN
      // unfiled work, so the handler scopes the owner select to "Mine".
      await page.goto('/atrium')
      await page.getByRole('button', { name: 'See all unfiled' }).click()
      await expect(
        chips(page).getByRole('button', { name: 'Unfiled', exact: true })
      ).toHaveAttribute('aria-pressed', 'true')
      await expect(ownerSelect).toHaveValue('mine')

      // Narrow to this run's probes. The loose doc stays; the FILED one and the
      // OTHER user's must be excluded. Before the fix the `filed` restriction
      // was silently dropped from the fetch, so everything rendered; before
      // the owner scope, the other user's unfiled doc did too.
      await searchBox(page).fill(tag)
      await awaitResultsFor(page, tag)
      await awaitSettledKey(page, /"filed":"unfiled"/)
      await awaitSettledKey(page, /"owner":"mine"/)
      await expect(looseCard).toBeVisible()
      await expect(filedCard).toHaveCount(0)
      await expect(theirsCard).toHaveCount(0)

      await page.screenshot({
        path: `${SHOT_DIR}/atrium-library-unfiled-chip.png`,
      })

      // The owner select stays live: widening to "Anyone" is the district-wide
      // unfiled audit, and the other user's doc appears (still unfiled-only).
      await ownerSelect.selectOption('any')
      await expect(page.locator('section[data-results-key]')).not.toHaveAttribute(
        'data-results-key',
        /"owner"/,
        { timeout: 15000 }
      )
      await expect(theirsCard).toBeVisible()
      await expect(looseCard).toBeVisible()
      await expect(filedCard).toHaveCount(0)

      // A section scope must not poison the view. Arriving via the legacy
      // `?collection=` deep link keeps the Home chip (and its "See all unfiled")
      // reachable; "unfiled" means "in no section", so the scope is DROPPED
      // rather than ANDed with `collection_id IS NULL` into an empty grid.
      await page.goto(`/atrium?collection=${collectionId}`)
      await chips(page).getByRole('button', { name: 'Home', exact: true }).click()
      await page.getByRole('button', { name: 'See all unfiled' }).click()
      await searchBox(page).fill(tag)
      await awaitResultsFor(page, tag)
      await awaitSettledKey(page, /"filed":"unfiled"/)
      await expect(page.locator('section[data-results-key]')).not.toHaveAttribute(
        'data-results-key',
        /"collectionId"/
      )
      await expect(looseCard).toBeVisible()
      await expect(filedCard).toHaveCount(0)
    } finally {
      // The admin's request context deletes the staff-owned probe too.
      await cleanup(context.request, ids, collectionId)
      await staff.close()
      await context.close()
    }
  })
}

test.describe('Atrium library view filters — Favorites & Unfiled chips (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  // Several server actions compile on first hit against the dev server, so the
  // default 60s per-test budget is too tight (same as the polish suite).
  test.describe.configure({ timeout: 180_000 })

  defineFavoritesChipTest()
  defineUnfiledChipTest()
})
