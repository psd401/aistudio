import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'

/**
 * E2E (gated): decision supersession lifecycle (Issue #1252, flow `decision-supersede`).
 *
 * Captures decision A, then captures decision B that supersedes A via the
 * `supersedes: [A]` payload field, and proves the lifecycle side effects on the
 * REST channel:
 *   - A flips to `status=superseded` with a `supersededAt` timestamp,
 *   - B is `status=accepted`,
 *   - a `SUPERSEDED_BY` edge (A → B) exists,
 *   - the "current decision" query (`nodeType=decision&status=accepted`) returns
 *     B and NOT A.
 *
 * The admin session's role maps to ALL_SCOPES (incl. graph:write) via REV-SEC-161,
 * so no API key is needed. Gated: needs the host :3100 dev server + seeded admin
 * with migration 115 applied (see docs/guides/e2e-authenticated-testing.md).
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

interface NodeResponse {
  data: {
    id: string
    nodeType: string
    status: string | null
    supersededAt: string | null
  }
}

interface Connection {
  edge: { edgeType: string; sourceNodeId: string; targetNodeId: string }
  connectedNode: { id: string; nodeType: string; name: string }
  direction: 'incoming' | 'outgoing'
}

interface ListResponse {
  data: Array<{ id: string; nodeType: string; status: string | null }>
}

test.describe('Decision supersession lifecycle (#1252)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session against the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md',
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
  })

  test('supersedes a prior decision: flips status, links SUPERSEDED_BY, current-decision query returns only B', async ({
    page,
  }) => {
    const tag = `E2E-SUPERSEDE-${Date.now()}`

    // 1. Capture decision A (the one that will be superseded).
    const aRes = await page.request.post('/api/v1/graph/decisions', {
      data: {
        decision: `${tag} use REST polling for job status`,
        decidedBy: `${tag} Platform Team`,
      },
    })
    expect(aRes.status()).toBe(201)
    const aId = ((await aRes.json()) as CaptureResponse).data.decisionNodeId
    expect(aId).toBeTruthy()

    // 2. Capture decision B superseding A.
    const bRes = await page.request.post('/api/v1/graph/decisions', {
      data: {
        decision: `${tag} switch job status to WebSocket push`,
        decidedBy: `${tag} Platform Team`,
        supersedes: [aId],
      },
    })
    expect(bRes.status()).toBe(201)
    const bId = ((await bRes.json()) as CaptureResponse).data.decisionNodeId
    expect(bId).toBeTruthy()
    expect(bId).not.toBe(aId)

    // 3. A is now superseded, with a supersededAt timestamp.
    const aNode = (await (await page.request.get(`/api/v1/graph/nodes/${aId}`)).json()) as NodeResponse
    expect(aNode.data.status).toBe('superseded')
    expect(aNode.data.supersededAt).toBeTruthy()

    // 4. B is the current (accepted) decision.
    const bNode = (await (await page.request.get(`/api/v1/graph/nodes/${bId}`)).json()) as NodeResponse
    expect(bNode.data.status).toBe('accepted')

    // 5. A SUPERSEDED_BY edge (A → B) exists — read from A's connections.
    const conn = (await (
      await page.request.get(`/api/v1/graph/nodes/${aId}/connections`)
    ).json()) as { data: Connection[] }
    const supersededBy = conn.data.find(
      (c) => c.edge.edgeType === 'SUPERSEDED_BY' && c.connectedNode.id === bId,
    )
    expect(supersededBy).toBeTruthy()

    // 6. "Current decision" query: accepted decisions matching the tag = only B.
    const listRes = await page.request.get(
      `/api/v1/graph/nodes?nodeType=decision&status=accepted&search=${encodeURIComponent(tag)}&limit=50`,
    )
    expect(listRes.status()).toBe(200)
    const list = (await listRes.json()) as ListResponse
    const ids = list.data.map((n) => n.id)
    expect(ids).toContain(bId)
    expect(ids).not.toContain(aId)
    // Every returned node is genuinely accepted.
    expect(list.data.every((n) => n.status === 'accepted')).toBe(true)
  })
})
