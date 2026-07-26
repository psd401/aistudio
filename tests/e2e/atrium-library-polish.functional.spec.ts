import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'
import { mkdirSync } from 'node:fs'

/**
 * E2E functional coverage for the #1336 library-list cluster.
 *
 * Flows: `atrium-library-search`, `atrium-library-bulk`.
 *
 * What this proves, and why each assertion exists:
 *
 *  - TAG SEARCH (A1). The search box used to be a client-side, TITLE-ONLY
 *    substring filter over the already-loaded page — `search` never reached
 *    `listContentAction`, so typing never refetched and anything beyond the
 *    first 50 rows was invisible no matter what you typed. The spec seeds a doc
 *    whose TITLE does not contain the term and whose TAG does, so a passing
 *    result is only possible with the server-side title-OR-tag predicate.
 *  - ZERO-RESULT STATE (A2). A nonsense term must render the explicit empty
 *    state and NO dangling "Load more".
 *  - TAG PILLS (A3) on both document and artifact cards.
 *  - BULK ACTIONS (A4), including the PARTIAL-FAILURE case that motivated the
 *    aggregated message: deleting a published object alongside a draft must
 *    delete the draft, refuse the published one, and report both in one
 *    sentence.
 *
 * Auth: mints a NextAuth session cookie for the seeded admin
 * (helpers/session-auth). Requires AUTH_SECRET and the host :3100 dev server
 * (NOT the prod-built :3000 container, which rejects the non-secure dev
 * cookie). See docs/guides/e2e-authenticated-testing.md. Gated behind
 * PLAYWRIGHT_AUTH_ENABLED so default CI (no seeded session) skips.
 */

const SHOT_DIR = '.verification'

/** Unique-per-run token so seeded rows never collide across runs or workers. */
function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}


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

function searchBox(page: import('@playwright/test').Page) {
  return page.getByRole('textbox', { name: 'Search content by title or tag' })
}

test.describe('Atrium library polish — search, tags, bulk (authenticated)', () => {
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

  test('atrium-library-search: a TAG match is found, tags render as pills, and a zero-result search shows an empty state with no "Load more"', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    try {
      const page = await context.newPage()
      const token = runToken()
      const tag = `phoenix${token}`

      // The TITLE deliberately omits the tag text. A title-only filter (the old
      // behavior) therefore cannot find this doc — only the server-side
      // title-OR-tag predicate can.
      const doc = await page.request.post('/api/v1/content', {
        data: {
          kind: 'document',
          title: `Quarterly plan ${token}`,
          body: '# plan',
          bodyFormat: 'markdown',
          tags: [tag, 'handbook', 'policy', 'overflow-a', 'overflow-b'],
        },
      })
      expect(doc.status()).toBe(201)
      const docId = (await doc.json())?.data?.id as string
      expect(docId).toBeTruthy()

      // An artifact with tags too — artifact cards rendered NO tags at all before
      // #1336, so this is the regression that proves the shared TagPills usage.
      const artifact = await page.request.post('/api/v1/content', {
        data: {
          kind: 'artifact',
          title: `Dashboard ${token}`,
          body: '<p>hi</p>',
          bodyFormat: 'html',
          tags: [tag],
        },
      })
      expect(artifact.status()).toBe(201)
      const artifactId = (await artifact.json())?.data?.id as string

      await page.goto('/atrium')
      await searchBox(page).fill(tag)

      // Both cards surface from a TAG-only match.
      const docCard = page.locator(`a[href="/atrium/${docId}/edit"]`)
      const artifactCard = page.locator(`a[href="/atrium/${artifactId}/edit"]`)
      await expect(docCard).toBeVisible({ timeout: 15000 })
      await expect(artifactCard).toBeVisible({ timeout: 15000 })

      // Tags render as PILLS (not a " · "-joined muted paragraph) on both card
      // kinds, capped with a "+N" overflow pill on the 5-tag doc.
      await expect(docCard.locator('.mer-tag-pill').first()).toBeVisible()
      await expect(docCard.locator('.mer-tag-pill-more')).toHaveText('+2')
      await expect(artifactCard.locator('.mer-tag-pill')).toHaveText(tag)

      await page.screenshot({
        path: `${SHOT_DIR}/atrium-library-search.png`,
        fullPage: false,
      })

      // A nonsense term: explicit empty state, and NO bare "Load more" button.
      await searchBox(page).fill(`no-such-content-zzz-${token}`)
      await expect(page.getByTestId('library-search-empty')).toBeVisible({
        timeout: 15000,
      })
      await expect(
        page.getByRole('button', { name: 'Load more' })
      ).toHaveCount(0)
      // The create affordance is suppressed too — a zero-MATCH state must not
      // read as "your library is empty".
      await expect(
        page.getByRole('button', { name: /Create with the agent/i })
      ).toHaveCount(0)

      await page.screenshot({
        path: `${SHOT_DIR}/atrium-library-search-empty.png`,
        fullPage: false,
      })

      await cleanup(page, [docId, artifactId])
    } finally {
      await context.close()
    }
  })

  test('atrium-library-bulk: multi-select archives and restores, and a mixed delete aggregates the partial failure', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    try {
      const page = await context.newPage()
      // Bulk delete raises a window.confirm — auto-accept every dialog.
      page.on('dialog', (dialog) => void dialog.accept())

      const token = runToken()
      const tag = `bulk${token}`

      // Two drafts, isolated from the rest of the library by a unique tag so the
      // search filter makes the selection deterministic.
      const ids: string[] = []
      for (const n of [1, 2]) {
        const res = await page.request.post('/api/v1/content', {
          data: {
            kind: 'document',
            title: `Bulk probe ${n} ${token}`,
            body: '# hi',
            bodyFormat: 'markdown',
            tags: [tag],
          },
        })
        expect(res.status()).toBe(201)
        ids.push((await res.json())?.data?.id as string)
      }

      await page.goto('/atrium')
      await searchBox(page).fill(tag)
      await expect(page.getByTestId(`select-${ids[0]}`)).toBeVisible({
        timeout: 15000,
      })

      // Select both, then bulk Archive.
      await page.getByTestId(`select-${ids[0]}`).check()
      await page.getByTestId(`select-${ids[1]}`).check()
      await expect(page.getByTestId('bulk-count')).toHaveText('2 selected')
      await page.screenshot({
        path: `${SHOT_DIR}/atrium-library-bulk.png`,
        fullPage: false,
      })
      await page.getByTestId('bulk-archive').click()
      await expect(page.getByTestId('bulk-message')).toContainText(
        'Archived 2 items',
        { timeout: 60000 }
      )

      // Both left the default view; both are under Archived.
      const archivedChip = page
        .getByRole('group', { name: 'Filter content' })
        .getByRole('button', { name: 'Archived', exact: true })
      for (const id of ids) {
        await expect(page.locator(`a[href="/atrium/${id}/edit"]`)).toHaveCount(0)
      }
      await archivedChip.click()
      await searchBox(page).fill(tag)
      for (const id of ids) {
        await expect(
          page.locator(`a[href="/atrium/${id}/edit"]`)
        ).toBeVisible({ timeout: 15000 })
      }

      // Bulk Restore from the archived view returns them to draft.
      await page.getByTestId(`select-${ids[0]}`).check()
      await page.getByTestId(`select-${ids[1]}`).check()
      await page.getByTestId('bulk-restore').click()
      await expect(page.getByTestId('bulk-message')).toContainText(
        'Restored 2 items',
        { timeout: 60000 }
      )

      // Mixed delete: publish ONE of them so the server refuses its delete with
      // a 409 while the other draft is removed — the partial-failure case the
      // aggregated message exists for.
      const published = await page.request.post(
        `/api/v1/content/${ids[0]}/publish`,
        { data: { destination: 'intranet' } }
      )
      expect([200, 201]).toContain(published.status())

      await page.goto('/atrium')
      await searchBox(page).fill(tag)
      await expect(page.getByTestId(`select-${ids[0]}`)).toBeVisible({
        timeout: 15000,
      })
      await page.getByTestId(`select-${ids[0]}`).check()
      await page.getByTestId(`select-${ids[1]}`).check()
      await page.getByTestId('bulk-delete').click()

      // ONE aggregated sentence covering both outcomes — not a toast storm.
      await expect(page.getByTestId('bulk-message')).toContainText(
        'Deleted 1 of 2',
        { timeout: 60000 }
      )
      await page.screenshot({
        path: `${SHOT_DIR}/atrium-library-bulk-partial.png`,
        fullPage: false,
      })

      // The draft is gone; the published object survives.
      expect(
        (await page.request.get(`/api/v1/content/${ids[1]}`)).status()
      ).toBe(404)
      expect(
        (await page.request.get(`/api/v1/content/${ids[0]}`)).status()
      ).toBe(200)

      await cleanup(page, ids)
    } finally {
      await context.close()
    }
  })
})
