import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'

/**
 * E2E (gated): REST decision capture round-trip (Issue #1251, flow `decision-rest-capture`).
 *
 * Proves — for the first time — that a decision capture actually round-trips:
 * captures decisions via `POST /api/v1/graph/decisions` and reads the persisted
 * subgraph back via the graph read endpoints (typed nodes + edges + completeness
 * score). Also asserts the Issue #1251 hardening: duplicate `relatedTo` UUIDs are
 * de-duplicated (one CONTEXT edge, not a 500), and an invalid payload returns a
 * typed 400 rather than a raw database error.
 *
 * The admin session's role maps to ALL_SCOPES (incl. graph:write) via REV-SEC-161,
 * so no API key is needed. Gated: needs the host :3100 dev server + seeded admin
 * (see docs/guides/e2e-authenticated-testing.md).
 */

interface CaptureResponse {
  data: {
    decisionNodeId: string
    nodesCreated: number
    edgesCreated: number
    completenessScore: number
    warnings?: string[]
  }
}

interface Connection {
  edge: { edgeType: string; sourceNodeId: string; targetNodeId: string }
  connectedNode: { id: string; nodeType: string; name: string }
  direction: 'incoming' | 'outgoing'
}

test.describe('Decision REST capture round-trip (#1251)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session against the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md',
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
  })

  test('captures a full + minimal decision and reads the subgraph back', async ({ page }) => {
    const tag = `E2E-REST-${Date.now()}`

    // 1. Capture a FULL decision (evidence + constraints + conditions + alternatives).
    const fullRes = await page.request.post('/api/v1/graph/decisions', {
      data: {
        decision: `${tag} adopt PostgreSQL for the data layer`,
        decidedBy: `${tag} Engineering Team`,
        reasoning: 'Strong ACID guarantees and JSON support',
        evidence: [`${tag} benchmark: 3x throughput`],
        constraints: [`${tag} budget under $500/mo`],
        conditions: [`${tag} revisit if write volume exceeds 50k ops/s`],
        alternatives_considered: ['MongoDB', 'DynamoDB'],
      },
    })
    expect(fullRes.status()).toBe(201)
    const full = (await fullRes.json()) as CaptureResponse
    expect(full.data.decisionNodeId).toBeTruthy()
    // Completeness score is present and, for a full decision, is the max.
    expect(typeof full.data.completenessScore).toBe('number')
    expect(full.data.completenessScore).toBe(100)
    expect(full.data.nodesCreated).toBeGreaterThan(1)

    // 2. Capture a MINIMAL decision (decision + decidedBy only).
    const minRes = await page.request.post('/api/v1/graph/decisions', {
      data: {
        decision: `${tag} switch CI to bun`,
        decidedBy: `${tag} Platform Team`,
      },
    })
    expect(minRes.status()).toBe(201)
    const min = (await minRes.json()) as CaptureResponse
    // Missing evidence/condition => rule-based score below max.
    expect(min.data.completenessScore).toBeLessThan(100)

    // 3. Read the full decision's connections back; assert typed nodes + edges.
    const connRes = await page.request.get(
      `/api/v1/graph/nodes/${full.data.decisionNodeId}/connections`,
    )
    expect(connRes.status()).toBe(200)
    const conn = (await connRes.json()) as { data: Connection[] }
    const edgeTypes = new Set(conn.data.map((c) => c.edge.edgeType))
    const nodeTypes = new Set(conn.data.map((c) => c.connectedNode.nodeType))

    // Person proposed the decision; evidence/constraint/condition informed it.
    expect(edgeTypes).toContain('PROPOSED')
    expect(edgeTypes).toContain('INFORMED')
    expect(edgeTypes).toContain('CONSTRAINED')
    expect(edgeTypes).toContain('CONDITION')
    expect(nodeTypes).toContain('person')
    expect(nodeTypes).toContain('evidence')
  })

  test('deduplicates duplicate relatedTo UUIDs into a single CONTEXT edge', async ({ page }) => {
    const tag = `E2E-DEDUP-${Date.now()}`

    // Create an anchor decision to reference.
    const anchorRes = await page.request.post('/api/v1/graph/decisions', {
      data: { decision: `${tag} anchor decision`, decidedBy: `${tag} Team` },
    })
    expect(anchorRes.status()).toBe(201)
    const anchor = (await anchorRes.json()) as CaptureResponse
    const anchorId = anchor.data.decisionNodeId

    // Capture a new decision that references the anchor TWICE (duplicate relatedTo).
    // Before #1251 this produced two identical CONTEXT edges -> 23505 -> masked 500.
    const dupRes = await page.request.post('/api/v1/graph/decisions', {
      data: {
        decision: `${tag} follow-on decision`,
        decidedBy: `${tag} Team`,
        relatedTo: [anchorId, anchorId],
      },
    })
    expect(dupRes.status()).toBe(201)
    const dup = (await dupRes.json()) as CaptureResponse

    // Read connections; exactly ONE CONTEXT edge from the anchor should exist.
    const connRes = await page.request.get(
      `/api/v1/graph/nodes/${dup.data.decisionNodeId}/connections`,
    )
    expect(connRes.status()).toBe(200)
    const conn = (await connRes.json()) as { data: Connection[] }
    const contextEdges = conn.data.filter(
      (c) => c.edge.edgeType === 'CONTEXT' && c.connectedNode.id === anchorId,
    )
    expect(contextEdges).toHaveLength(1)
  })

  test('returns a typed 400 for an invalid payload (never a raw DB error)', async ({ page }) => {
    const res = await page.request.post('/api/v1/graph/decisions', {
      data: { decision: 'missing decidedBy' },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    // A structured error envelope, not a raw Postgres string.
    expect(JSON.stringify(body)).not.toMatch(/duplicate key|violates|23505|chk_no_self_reference/i)
  })
})
