import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'

/**
 * E2E (gated): decision-package retrieval (Issue #1252, flow `decision-package-retrieval`).
 *
 * Captures a full decision B (person + evidence + constraint + condition) that
 * supersedes a prior decision A, then fetches B's decision package via
 * `GET /api/v1/graph/nodes/{id}/package` and asserts one self-contained response
 * contains the decision, its person / evidence / condition nodes, and the
 * supersession link back to A — gathered by the depth-bounded, cycle-safe
 * recursive CTE.
 *
 * Gated: needs the host :3100 dev server + seeded admin with migration 115
 * applied (see docs/guides/e2e-authenticated-testing.md).
 */

interface CaptureResponse {
  data: { decisionNodeId: string }
}

interface PackageNode {
  id: string
  name: string
  nodeType: string
  status: string | null
  depth: number
}

interface PackageResponse {
  data: {
    decision: PackageNode
    nodes: PackageNode[]
    persons: PackageNode[]
    evidence: PackageNode[]
    constraints: PackageNode[]
    conditions: PackageNode[]
    supersessionChain: Array<{ supersededId: string; supersededById: string }>
    depth: number
  }
  meta: { depth: number }
}

test.describe('Decision-package retrieval (#1252)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session against the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md',
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
  })

  test('assembles a self-contained decision package including the supersession chain', async ({
    page,
  }) => {
    const tag = `E2E-PACKAGE-${Date.now()}`

    // 1. Prior decision A.
    const aRes = await page.request.post('/api/v1/graph/decisions', {
      data: { decision: `${tag} store files on local disk`, decidedBy: `${tag} Infra Team` },
    })
    expect(aRes.status()).toBe(201)
    const aId = ((await aRes.json()) as CaptureResponse).data.decisionNodeId

    // 2. Full decision B superseding A (person + evidence + constraint + condition).
    const bRes = await page.request.post('/api/v1/graph/decisions', {
      data: {
        decision: `${tag} migrate file storage to S3`,
        decidedBy: `${tag} Infra Team`,
        evidence: [`${tag} durability 99.999999999%`],
        constraints: [`${tag} egress budget under $200/mo`],
        conditions: [`${tag} revisit if egress exceeds 5TB/mo`],
        supersedes: [aId],
      },
    })
    expect(bRes.status()).toBe(201)
    const bId = ((await bRes.json()) as CaptureResponse).data.decisionNodeId

    // 3. Fetch B's decision package.
    const pkgRes = await page.request.get(`/api/v1/graph/nodes/${bId}/package`)
    expect(pkgRes.status()).toBe(200)
    const pkg = (await pkgRes.json()) as PackageResponse

    // 4. The seed is B, at depth 0.
    expect(pkg.data.decision.id).toBe(bId)
    expect(pkg.data.decision.depth).toBe(0)
    expect(pkg.data.decision.status).toBe('accepted')

    // 5. Role-grouped nodes are all present in one response.
    expect(pkg.data.persons.length).toBeGreaterThan(0)
    expect(pkg.data.evidence.length).toBeGreaterThan(0)
    expect(pkg.data.conditions.length).toBeGreaterThan(0)

    // 6. The supersession chain links B → A.
    const link = pkg.data.supersessionChain.find(
      (l) => l.supersededId === aId && l.supersededById === bId,
    )
    expect(link).toBeTruthy()

    // 7. A appears in the package as a reachable node within the depth bound.
    expect(pkg.data.nodes.map((n) => n.id)).toContain(aId)
  })
})
