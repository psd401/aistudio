import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
  SEEDED_NO_CAPABILITY_EMAIL,
  SEEDED_NO_CAPABILITY_SUB,
} from './helpers/session-auth'

/**
 * E2E functional coverage for the Atrium Phase 5 REST v1 capability gate (#1055).
 *
 * The always-run guard spec (atrium-content-api.guard.spec.ts) proves the routes
 * are auth-gated (401 unauthenticated). THIS spec proves the second gate that a
 * session caller must also clear: a browser session authenticates with the
 * wildcard scope `["*"]`, which trivially satisfies every requireScope("content:*")
 * check, so scope enforcement alone would let ANY logged-in user author content.
 * assertContentAuthoringCapability closes that by additionally requiring the
 * `atrium-content` capability for session callers — mirroring every Atrium UI
 * server action.
 *
 * - Seeded student (SEEDED_NO_CAPABILITY_SUB) holds NO capabilities  -> 403.
 * - Seeded admin  (SEEDED_ADMIN_SUB) holds every capability          -> success.
 *
 * Auth: mints a NextAuth session cookie per user (helpers/session-auth). Requires
 * AUTH_SECRET in env and the host :3100 dev server (NOT the prod-built :3000
 * container, which rejects the non-secure dev cookie). See
 * docs/guides/e2e-authenticated-testing.md. Gated behind PLAYWRIGHT_AUTH_ENABLED
 * so default CI (no seeded session) skips.
 */

test.describe('Atrium content v1 — session capability gate (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  test('session WITHOUT the atrium-content capability (student) -> 403 on create', async ({
    page,
  }) => {
    await authenticateContext(
      page.context(),
      SEEDED_NO_CAPABILITY_EMAIL,
      SEEDED_NO_CAPABILITY_SUB
    )
    const res = await page.request.post('/api/v1/content', {
      data: { kind: 'document', title: 'e2e capability-gate probe' },
    })
    // The gate fires before any write: ForbiddenError -> 403 CONTENT_FORBIDDEN,
    // NOT the 401 an unauthenticated caller gets (the session IS valid) and NOT
    // a 2xx (scope alone would have let this through before the fix).
    expect(res.status()).toBe(403)
  })

  test('session WITHOUT the capability (student) -> 403 on version create', async ({
    page,
  }) => {
    await authenticateContext(
      page.context(),
      SEEDED_NO_CAPABILITY_EMAIL,
      SEEDED_NO_CAPABILITY_SUB
    )
    const someId = '00000000-0000-0000-0000-000000000000'
    const res = await page.request.post(`/api/v1/content/${someId}/versions`, {
      data: { body: 'probe', bodyFormat: 'markdown' },
    })
    // Denied by the capability gate before the (missing) object is ever loaded,
    // so this is 403 rather than the 404 an authorized caller would get.
    expect(res.status()).toBe(403)
  })

  test('session WITH every capability (admin) -> create succeeds', async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const res = await page.request.post('/api/v1/content', {
      data: { kind: 'document', title: 'e2e admin authoring probe' },
    })
    // Regression guard: legitimate authoring by a capability-holding session must
    // still succeed — the gate must not block authorized humans.
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body?.data?.id).toBeTruthy()
  })
})
