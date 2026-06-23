import { test, expect } from '@playwright/test'
import {
  authenticateContext,
  SEEDED_NO_CAPABILITY_EMAIL,
  SEEDED_NO_CAPABILITY_SUB,
} from './helpers/session-auth'

/**
 * E2E: capability-gated API route auth guards (Issue #928).
 *
 * Each capability-gated route checks the session first (401 when absent) and
 * then the capability (403 when an authenticated user lacks it). The always-run
 * tests assert the 401 guard using the unauthenticated `{ request }` fixture,
 * which carries no browser cookies and is therefore always unauthenticated.
 *
 * The 403 capability-denied path is asserted by the authenticated suite below,
 * which mints a session for the seeded student user (SEEDED_NO_CAPABILITY_SUB).
 * The student role is granted NO role_capabilities (see scripts/db/seed-local.sql),
 * so capability-gated routes return 403 — proving the guard rejects an
 * authenticated user who lacks the capability, not just the unauthenticated case.
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

test.describe('Capability API guards — authenticated 403 (no-capability user)', () => {
  // Authenticated as the seeded student user, which holds no capabilities. Gated
  // behind PLAYWRIGHT_AUTH_ENABLED (requires AUTH_SECRET + a server whose secret
  // matches it — the host dev server, not the prod-built container). See
  // docs/guides/e2e-authenticated-testing.md.
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  test('GET /api/schedules -> 403 (assistant-architect denied)', async ({ browser }) => {
    const context = await browser.newContext()
    await authenticateContext(context, SEEDED_NO_CAPABILITY_EMAIL, SEEDED_NO_CAPABILITY_SUB)
    try {
      const res = await context.request.get('/api/schedules')
      expect(res.status()).toBe(403)
    } finally {
      await context.close()
    }
  })

  test('GET /api/assistant-architects -> 403 (assistant-architect denied)', async ({ browser }) => {
    const context = await browser.newContext()
    await authenticateContext(context, SEEDED_NO_CAPABILITY_EMAIL, SEEDED_NO_CAPABILITY_SUB)
    try {
      const res = await context.request.get('/api/assistant-architects')
      expect(res.status()).toBe(403)
    } finally {
      await context.close()
    }
  })

  test('POST /api/compare -> 403 (model-compare denied)', async ({ browser }) => {
    const context = await browser.newContext()
    await authenticateContext(context, SEEDED_NO_CAPABILITY_EMAIL, SEEDED_NO_CAPABILITY_SUB)
    try {
      // Schema-valid body so the only failing gate is the capability check, not body validation.
      const res = await context.request.post('/api/compare', {
        data: { prompt: 'e2e capability probe', model1Id: '1', model2Id: '2' },
      })
      expect(res.status()).toBe(403)
    } finally {
      await context.close()
    }
  })
})
