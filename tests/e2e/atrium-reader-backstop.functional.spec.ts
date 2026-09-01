import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
  SEEDED_NO_CAPABILITY_EMAIL,
  SEEDED_NO_CAPABILITY_SUB,
} from './helpers/session-auth'
import { mkdirSync } from 'node:fs'

/**
 * E2E functional coverage for the `/c/{slug}` dead-link backstop.
 *
 * The defect this pins: agents and API callers handed out `/c/{slug}` links for
 * content with no live intranet publication (unconditionally before PR #1699;
 * still possible for `status='published'` objects whose only publication is
 * `public_web` or whose intranet publication was retracted). The reader
 * existence-masks, so those links 404'd for everyone — including the owner.
 *
 * The backstop (app/(protected)/c/[slug]/page.tsx): an unpublished object whose
 * requester passes `canView` now REDIRECTS to the authoring surface instead of
 * 404ing. The mask is unchanged for everyone else:
 *
 *  - Owner follows a `/c/` link to their own unpublished DOCUMENT → lands on
 *    `/atrium/{id}/edit` (the surface that renders the head version).
 *  - Owner follows a `/c/` link to their own unpublished ARTIFACT → lands on
 *    `/atrium/{id}/view` (the chrome-free full-screen view).
 *  - An out-of-audience user (no ownership, no grant) probing the same slug
 *    still gets a plain 404 — the redirect must never confirm existence to a
 *    principal who cannot view the object.
 *
 * The unit-level decision table lives in
 * tests/unit/atrium-reader-page-masking.test.tsx; this spec proves the wiring
 * end-to-end through middleware, the RSC redirect, and the authoring surfaces.
 *
 * Auth: mints a NextAuth session cookie for seeded users (helpers/session-auth).
 * Requires AUTH_SECRET in env and the host :3100 dev server. Gated behind
 * PLAYWRIGHT_AUTH_ENABLED so default CI (no seeded session) skips.
 */

const SHOT_DIR = 'docs/verification/atrium-reader-backstop'

function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

/**
 * Best-effort teardown for objects a spec created (drafts only here, so no
 * unpublish step is needed). Failures are ignored — teardown must never mask
 * the real assertion failure.
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

test.describe('Atrium reader dead-link backstop (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  // First hits compile the reader AND the authoring surface on the dev server,
  // so the default 60s per-test budget is too tight (same rationale as the
  // sibling functional specs).
  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true })
  })

  test('an unpublished DOCUMENT /c/ link redirects its owner to the edit surface', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const page = await context.newPage()
    const created: string[] = []
    try {
      const title = `Backstop draft doc ${runToken()}`
      const res = await page.request.post('/api/v1/content', {
        data: {
          kind: 'document',
          title,
          body: `# ${title}\n\nDraft body that only the backstop can reach.`,
          bodyFormat: 'markdown',
          visibility: { level: 'private' },
        },
      })
      expect(res.status()).toBe(201)
      const data = (await res.json())?.data
      expect(data?.id).toBeTruthy()
      expect(data?.slug).toBeTruthy()
      created.push(data.id as string)

      // The dead link every pre-fix agent DM contains. It must resolve — for a
      // viewer — to the authoring surface, not 404.
      await page.goto(`/c/${data.slug}`)
      await expect(page).toHaveURL(
        (url) => url.pathname === `/atrium/${data.id}/edit`,
        { timeout: 60000 }
      )
      await page.screenshot({
        path: `${SHOT_DIR}/document-redirect-edit-surface.png`,
        fullPage: false,
      })
    } finally {
      await cleanup(page, created)
      await context.close()
    }
  })

  test('an unpublished ARTIFACT /c/ link redirects its owner to the full-screen view surface', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const page = await context.newPage()
    const created: string[] = []
    try {
      const title = `Backstop draft artifact ${runToken()}`
      const res = await page.request.post('/api/v1/content', {
        data: {
          kind: 'artifact',
          title,
          bodyFormat: 'html',
          body: '<html><body><h1>Backstop probe artifact</h1></body></html>',
          visibility: { level: 'private' },
        },
      })
      expect(res.status()).toBe(201)
      const data = (await res.json())?.data
      expect(data?.id).toBeTruthy()
      expect(data?.slug).toBeTruthy()
      created.push(data.id as string)

      await page.goto(`/c/${data.slug}`)
      await expect(page).toHaveURL(
        (url) => url.pathname === `/atrium/${data.id}/view`,
        { timeout: 60000 }
      )
      await page.screenshot({
        path: `${SHOT_DIR}/artifact-redirect-view-surface.png`,
        fullPage: false,
      })
    } finally {
      await cleanup(page, created)
      await context.close()
    }
  })

  test('the same unpublished slug still 404s for an out-of-audience user (mask intact)', async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(ownerContext, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const ownerPage = await ownerContext.newPage()
    const created: string[] = []
    try {
      const title = `Backstop mask probe ${runToken()}`
      const res = await ownerPage.request.post('/api/v1/content', {
        data: {
          kind: 'document',
          title,
          body: `# ${title}\n\nPrivate draft nobody else may learn exists.`,
          bodyFormat: 'markdown',
          visibility: { level: 'private' },
        },
      })
      expect(res.status()).toBe(201)
      const data = (await res.json())?.data
      expect(data?.slug).toBeTruthy()
      created.push(data.id as string)

      // A different seeded user — no ownership, no grant — must get the same
      // 404 an absent slug produces. A redirect here would confirm the slug
      // exists and re-open the enumeration channel the reader masks against.
      const probeContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      })
      await authenticateContext(
        probeContext,
        SEEDED_NO_CAPABILITY_EMAIL,
        SEEDED_NO_CAPABILITY_SUB
      )
      try {
        const probePage = await probeContext.newPage()
        const resp = await probePage.goto(`/c/${data.slug}`)
        expect(resp?.status()).toBe(404)
        // Still ON the probed URL — no redirect leaked the object's id.
        await expect(probePage).toHaveURL(
          (url) => url.pathname === `/c/${data.slug}`
        )
      } finally {
        await probeContext.close()
      }
    } finally {
      await cleanup(ownerPage, created)
      await ownerContext.close()
    }
  })
})
