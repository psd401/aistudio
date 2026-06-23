import { test, expect } from '@playwright/test'

/**
 * E2E: capability-gated API route auth guards (Issue #928).
 *
 * Each capability-gated route checks the session first (401 when absent) and
 * then the capability (403 when an authenticated user lacks it). These always-run
 * tests assert the 401 guard using the unauthenticated `{ request }` fixture,
 * which carries no browser cookies and is therefore always unauthenticated.
 *
 * The 403 capability-denied path requires an authenticated session WITHOUT the
 * capability (a purpose-seeded no-capability user); it is documented here but not
 * asserted, since the shared auth state holds the capability and would 200.
 *
 * Pattern: docs/learnings/testing/2026-06-15-playwright-e2e-auth-gating-pattern.md
 * (Do NOT substitute page.evaluate(fetch) — it would send browser cookies.)
 */

test.describe('Capability API guards — unauthenticated 401 (always-run)', () => {
  test('GET /api/schedules -> 401', async ({ request }) => {
    const res = await request.get('/api/schedules')
    expect(res.status()).toBe(401)
  })

  test('POST /api/schedules -> 401 (session checked before body parse)', async ({ request }) => {
    const res = await request.post('/api/schedules', { data: {} })
    expect(res.status()).toBe(401)
  })

  test('GET /api/assistant-architects -> 401', async ({ request }) => {
    const res = await request.get('/api/assistant-architects')
    expect(res.status()).toBe(401)
  })

  test('GET /api/navigation -> 401', async ({ request }) => {
    const res = await request.get('/api/navigation')
    expect(res.status()).toBe(401)
  })

  test('POST /api/compare -> 401', async ({ request }) => {
    // /api/compare validates the body BEFORE the session check, so an empty body
    // would 400. Send a schema-valid payload (model ids are strings) so the only
    // gate that can fail is the 401 auth guard.
    const res = await request.post('/api/compare', {
      data: { prompt: 'e2e auth probe', model1Id: '1', model2Id: '2' },
    })
    expect(res.status()).toBe(401)
  })
})
