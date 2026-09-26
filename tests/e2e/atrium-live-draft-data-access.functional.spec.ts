/**
 * Atrium Live/Draft gaps for artifacts (#1789) — end to end over the real REST
 * surface and the real reader.
 *
 * Two defects, both of which let an author's DRAFT change what a LIVE page does:
 *
 *  1. `data_access` lived on the OBJECT, so flipping the mode while building the
 *     next version immediately changed what `/c/{slug}` could do for every
 *     reader — a Live records-mode sign-up sheet stopped accepting submissions,
 *     a Live dashboard went dark — with no republish. The mode is now stamped on
 *     `content_versions.data_access` (migration 184) and
 *     `contentService.update` writes a NEW version rather than re-stamping the
 *     one a live publication pins.
 *  2. `/c/{slug}`'s "Full screen" linked to `/atrium/{id}/view`, which rendered
 *     the working HEAD — so a reader on a Live page landed on the author's
 *     half-finished draft. It now carries the published version id.
 *
 * What this spec can prove locally, and what it cannot:
 *  - The version STAMPS are observable through `GET /api/v1/content/:id/versions`
 *    (`ContentVersionDTO.dataAccess`), so the "Live keeps its mode" claim is
 *    asserted directly against the database's own rows.
 *  - The reader's Full screen href is observable in the DOM.
 *  - The sandbox PIN itself is not: the local harness has no
 *    `ATRIUM_SANDBOX_ORIGIN`, so the reader renders the fail-closed notice
 *    instead of a frame (see `atrium-artifact.guard.spec.ts`). The pin and the
 *    bridge's server-side re-check are covered by
 *    `tests/unit/atrium-reader-page-masking.test.tsx`,
 *    `tests/unit/atrium-artifact-view-page-bridge.test.tsx`,
 *    `tests/unit/atrium-rendered-version-data-access.test.ts` and
 *    `tests/unit/atrium-artifact-data-actions.test.ts` — the same division of
 *    labour the sibling #1705 spec uses.
 *
 * Auth: mints a NextAuth session cookie for seeded users (helpers/session-auth).
 * Requires AUTH_SECRET in env and the host dev server. Gated behind
 * PLAYWRIGHT_AUTH_ENABLED so default CI (no seeded session) skips.
 */

import { expect, test } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'
import { mkdirSync } from 'node:fs'

const SHOT_DIR = 'docs/verification/atrium-live-draft-data-access'

function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

interface VersionRow {
  id: string
  versionNumber: number
  dataAccess: string | null
}

/** Newest-first version list, as the REST surface returns it. */
async function listVersions(
  page: import('@playwright/test').Page,
  id: string
): Promise<VersionRow[]> {
  const res = await page.request.get(`/api/v1/content/${id}/versions`)
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { data?: VersionRow[] }
  return body.data ?? []
}

/** Flip the artifact's data-bridge mode through the REST surface. */
async function setDataAccess(
  page: import('@playwright/test').Page,
  id: string,
  mode: string
): Promise<void> {
  const res = await page.request.patch(`/api/v1/content/${id}`, {
    data: { dataAccess: mode },
  })
  expect(res.status()).toBe(200)
}

/** Best-effort teardown. Failures never mask the real assertion failure. */
async function cleanup(
  page: import('@playwright/test').Page,
  ids: string[]
): Promise<void> {
  for (const id of ids) {
    try {
      // Delete refuses a LIVE object (409), so retract first. A draft simply
      // has nothing to retract and the 404 is swallowed.
      await page.request.delete(`/api/v1/content/${id}/publish/intranet`)
    } catch {
      // Ignored on purpose.
    }
    try {
      await page.request.delete(`/api/v1/content/${id}`)
    } catch {
      // Ignored on purpose.
    }
  }
}

test.describe('Atrium Live/Draft artifact data access (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  // First hits compile the reader on the dev server, so the default 60s budget
  // is too tight (same rationale as the sibling functional specs).
  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true })
  })

  test('a mode change on a Live artifact leaves the published version stamped as published', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const page = await context.newPage()
    const created: string[] = []
    try {
      const title = `Live draft mode probe ${runToken()}`
      const res = await page.request.post('/api/v1/content', {
        data: {
          kind: 'artifact',
          title,
          bodyFormat: 'html',
          body: '<html><body><h1>Sign-up sheet</h1></body></html>',
          visibility: { level: 'internal' },
        },
      })
      expect(res.status()).toBe(201)
      const data = (await res.json())?.data
      expect(data?.id).toBeTruthy()
      created.push(data.id as string)

      // A new artifact defaults to `records` (#1705), and v1 is stamped with it.
      const initial = await listVersions(page, data.id as string)
      expect(initial).toHaveLength(1)
      expect(initial[0].dataAccess).toBe('records')
      const publishedVersionId = initial[0].id

      const published = await page.request.post(
        `/api/v1/content/${data.id}/publish`,
        { data: { destination: 'intranet' } }
      )
      expect([200, 201]).toContain(published.status())

      // The author starts turning it into a live dashboard and flips the mode.
      // BEFORE #1789 this re-capabilitied the published version in place.
      await setDataAccess(page, data.id as string, 'query')

      const after = await listVersions(page, data.id as string)
      // A NEW version carries the new mode; the published one is untouched.
      expect(after.length).toBe(2)
      const stillPublished = after.find((v) => v.id === publishedVersionId)
      expect(stillPublished?.dataAccess).toBe('records')
      const head = after.find((v) => v.id !== publishedVersionId)
      expect(head?.dataAccess).toBe('query')
    } finally {
      await cleanup(page, created)
      await context.close()
    }
  })

  test('a mode change on a DRAFT artifact stamps the draft in place', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const page = await context.newPage()
    const created: string[] = []
    try {
      const title = `Draft mode probe ${runToken()}`
      const res = await page.request.post('/api/v1/content', {
        data: {
          kind: 'artifact',
          title,
          bodyFormat: 'html',
          body: '<html><body><h1>Draft dashboard</h1></body></html>',
          visibility: { level: 'private' },
        },
      })
      expect(res.status()).toBe(201)
      const data = (await res.json())?.data
      created.push(data.id as string)

      await setDataAccess(page, data.id as string, 'query')

      // Nothing is Live, so there is nothing to protect: the head is stamped in
      // place and no version is forked (the author's preview picks the new mode
      // up immediately).
      const after = await listVersions(page, data.id as string)
      expect(after).toHaveLength(1)
      expect(after[0].dataAccess).toBe('query')
    } finally {
      await cleanup(page, created)
      await context.close()
    }
  })

  test('the reader links Full screen to the published version, not the head', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const page = await context.newPage()
    const created: string[] = []
    try {
      const title = `Full screen version probe ${runToken()}`
      const res = await page.request.post('/api/v1/content', {
        data: {
          kind: 'artifact',
          title,
          bodyFormat: 'html',
          body: '<html><body><h1>Device repair dashboard</h1></body></html>',
          visibility: { level: 'internal' },
        },
      })
      expect(res.status()).toBe(201)
      const data = (await res.json())?.data
      created.push(data.id as string)

      const versions = await listVersions(page, data.id as string)
      const publishedVersionId = versions[0].id

      const published = await page.request.post(
        `/api/v1/content/${data.id}/publish`,
        { data: { destination: 'intranet' } }
      )
      expect([200, 201]).toContain(published.status())

      // Advance the head so "the published version" and "the head" differ — the
      // exact state in which the old unqualified link showed readers the draft.
      // A plain save moves Live onto the new head since #1837, unless the data
      // mode differs from Live's — so flip the mode first to stay draft-ahead.
      await setDataAccess(page, data.id as string, 'query')
      const newVersion = await page.request.post(
        `/api/v1/content/${data.id}/versions`,
        {
          data: {
            body: '<html><body><h1>WORK IN PROGRESS — broken SQL</h1></body></html>',
            bodyFormat: 'html',
            summary: 'draft ahead of live',
          },
        }
      )
      expect([200, 201]).toContain(newVersion.status())

      await page.goto(`/c/${data.slug}`)
      const fullScreen = page.getByTestId('reader-fullscreen-link')
      await expect(fullScreen).toBeVisible({ timeout: 60000 })
      await expect(fullScreen).toHaveAttribute(
        'href',
        `/atrium/${data.id}/view?version=${publishedVersionId}`
      )
      await page.screenshot({
        path: `${SHOT_DIR}/reader-full-screen-pins-published-version.png`,
        fullPage: false,
      })
    } finally {
      await cleanup(page, created)
      await context.close()
    }
  })
})
