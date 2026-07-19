import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'

/**
 * E2E (gated): semantic decision search (Issue #1252, flow `decision-semantic-search`).
 *
 * Captures a decision, then searches with a PARAPHRASE (no shared keywords) via
 * `GET /api/v1/graph/nodes?q=...&nodeType=decision`.
 *
 * The endpoint degrades gracefully: when the Bedrock embedding call succeeds the
 * response is `method=semantic` and the paraphrase matches the decision; when
 * embeddings are unavailable in the environment it is `method=lexical-fallback`.
 * This spec asserts the semantic match when available, and otherwise verifies the
 * documented graceful degradation plus that a lexical keyword still finds the
 * node — so the flow is meaningful with or without Bedrock in the test env.
 *
 * Gated: needs the host :3100 dev server + seeded admin with migration 115
 * applied (see docs/guides/e2e-authenticated-testing.md).
 */

interface CaptureResponse {
  data: { decisionNodeId: string }
}

interface SearchResponse {
  data: Array<{ id: string; name: string; similarity?: number }>
  meta: { method: 'semantic' | 'lexical-fallback' | 'lexical' }
}

test.describe('Semantic decision search (#1252)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session against the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md',
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
  })

  test('returns paraphrase matches when embeddings are available, degrades cleanly otherwise', async ({
    page,
  }) => {
    const tag = `E2E-SEMANTIC-${Date.now()}`
    const keyword = `zeppelin${Date.now()}` // distinctive lexical token in the decision text

    // 1. Capture a decision with a distinctive topic.
    const capRes = await page.request.post('/api/v1/graph/decisions', {
      data: {
        decision: `${tag} adopt ${keyword} for scheduling the nightly data export cron`,
        decidedBy: `${tag} Data Team`,
      },
    })
    expect(capRes.status()).toBe(201)
    const decisionId = ((await capRes.json()) as CaptureResponse).data.decisionNodeId

    // 2. Search with a PARAPHRASE that shares no keywords with the stored text.
    const paraphrase = `which tool runs our evening batch report jobs on a timer`
    const res = await page.request.get(
      `/api/v1/graph/nodes?q=${encodeURIComponent(paraphrase)}&nodeType=decision&limit=25`,
    )
    expect(res.status()).toBe(200)
    const body = (await res.json()) as SearchResponse

    if (body.meta.method === 'semantic') {
      // Embeddings available: the paraphrase should surface the decision.
      const ids = body.data.map((n) => n.id)
      expect(ids).toContain(decisionId)
      // Semantic results carry a similarity score.
      const match = body.data.find((n) => n.id === decisionId)
      expect(typeof match?.similarity).toBe('number')
    } else {
      // Embeddings unavailable in this env: verify documented graceful
      // degradation, then confirm the endpoint still finds the node via a
      // lexical keyword the fallback can match.
      expect(body.meta.method).toBe('lexical-fallback')
      const kwRes = await page.request.get(
        `/api/v1/graph/nodes?q=${encodeURIComponent(keyword)}&nodeType=decision&limit=25`,
      )
      expect(kwRes.status()).toBe(200)
      const kw = (await kwRes.json()) as SearchResponse
      expect(kw.data.map((n) => n.id)).toContain(decisionId)
    }
  })
})
