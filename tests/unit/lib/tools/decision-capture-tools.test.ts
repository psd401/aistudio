import { describe, it, expect, beforeEach } from "@jest/globals"

// ============================================
// Mocks — the commit path routes through the shared decision-capture-service,
// which persists via executeTransaction (globally mocked in jest.setup.js).
// The translator is stub-mocked so importing the service does not pull in the
// heavy AI-provider modules (the conversational commit path never calls it).
// ============================================

jest.mock("@/lib/graph/decision-api-translator", () => ({
  __esModule: true,
  translatePayloadToGraph: jest.fn(),
  computeLlmScore: jest.fn(),
}))

import {
  createDecisionCaptureTools,
} from "@/lib/tools/decision-capture-tools"
import type {
  CommitDecisionArgs,
  CommitDecisionResult,
  ProposeDecisionArgs,
  ProposeDecisionResult,
  SearchGraphNodesArgs,
  SearchGraphNodesResult,
} from "@/lib/tools/decision-capture-types"
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client"
import type { Tool } from "ai"

const mockExecuteQuery = executeQuery as jest.MockedFunction<typeof executeQuery>
const mockExecuteTransaction = executeTransaction as jest.MockedFunction<typeof executeTransaction>

const USER_ID = 42

// ============================================
// Transaction mock — captures inserted node/edge values
// ============================================

function makeTx(opts: {
  existingRows?: Array<{ id: string; nodeType: string }>
  nodeIds?: string[]
  failEdgeCode?: string
  failNodeCode?: string
}) {
  const { existingRows = [], nodeIds = [], failEdgeCode, failNodeCode } = opts
  let nodeIdx = 0
  const insertedNodes: Array<Record<string, unknown>> = []
  const insertedEdges: Array<Record<string, unknown>> = []

  const tx = {
    // Reused-node verification: one batched SELECT awaited directly off where().
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(existingRows),
      }),
    }),
    // Both nodes and edges arrive as batched arrays; edge rows carry edgeType.
    insert: () => ({
      values: (vals: unknown) => {
        const rows = vals as Array<Record<string, unknown>>
        if (rows.length > 0 && "edgeType" in rows[0]) {
          insertedEdges.push(...rows)
          return {
            returning: () =>
              failEdgeCode
                ? Promise.reject({ code: failEdgeCode })
                : Promise.resolve(rows.map((_, i) => ({ id: `edge-${i}` }))),
          }
        }
        insertedNodes.push(...rows)
        // Node inserts are awaited directly (ids are generated client-side, no
        // RETURNING), so failure must reject from values() itself.
        if (failNodeCode) {
          return Promise.reject({ code: failNodeCode })
        }
        const ids = rows.map(() => {
          const id = nodeIds[nodeIdx] ?? `node-${nodeIdx + 1}`
          nodeIdx++
          return { id }
        })
        return { returning: () => Promise.resolve(ids) }
      },
    }),
  }

  return { tx, insertedNodes, insertedEdges }
}

function useTx(opts: Parameters<typeof makeTx>[0]) {
  const built = makeTx(opts)
  mockExecuteTransaction.mockImplementation(async (cb: unknown) => {
    return (cb as (t: unknown) => Promise<void>)(built.tx)
  })
  return built
}

// Narrowing helpers for the CommitDecisionResult discriminated union.
function expectSuccess(result: CommitDecisionResult): Extract<CommitDecisionResult, { success: true }> {
  if (!result.success) throw new Error(`Expected success, got error: ${result.error}`)
  return result
}

function expectFailure(result: CommitDecisionResult): Extract<CommitDecisionResult, { success: false }> {
  if (result.success) throw new Error("Expected failure, got success")
  return result
}

// ============================================
// Tool accessors
// ============================================

type ToolExec<A, R> = (args: A) => Promise<R>
function getTools() {
  const tools = createDecisionCaptureTools(USER_ID) as Record<string, Tool>
  return {
    search: tools.search_graph_nodes.execute as unknown as ToolExec<SearchGraphNodesArgs, SearchGraphNodesResult>,
    propose: tools.propose_decision.execute as unknown as ToolExec<ProposeDecisionArgs, ProposeDecisionResult>,
    commit: tools.commit_decision.execute as unknown as ToolExec<CommitDecisionArgs, CommitDecisionResult>,
  }
}

// A minimal but complete subgraph (decision + person + evidence + condition).
function fullSubgraph(): Pick<CommitDecisionArgs, "nodes" | "edges"> {
  return {
    nodes: [
      { tempId: "d", name: "Adopt PG", nodeType: "decision", description: null },
      { tempId: "p", name: "Eng", nodeType: "person", description: null },
      { tempId: "e", name: "Benchmarks", nodeType: "evidence", description: null },
      { tempId: "c", name: "Revisit at 10TB", nodeType: "condition", description: null },
    ],
    edges: [
      { sourceTempId: "p", targetTempId: "d", edgeType: "PROPOSED" },
      { sourceTempId: "e", targetTempId: "d", edgeType: "INFORMED" },
      { sourceTempId: "c", targetTempId: "d", edgeType: "CONDITION" },
    ],
  }
}

// ============================================
// search_graph_nodes
// ============================================

describe("search_graph_nodes tool", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("maps queryGraphNodes results to the tool result shape", async () => {
    mockExecuteQuery.mockResolvedValue([
      { id: "n1", name: "Existing decision", nodeType: "decision", nodeClass: "decision", description: "d", createdAt: new Date() },
    ] as never)

    const { search } = getTools()
    const result = await search({ query: "decision" })

    expect(result.total).toBe(1)
    expect(result.nodes[0]).toMatchObject({ id: "n1", name: "Existing decision", nodeType: "decision" })
  })
})

// ============================================
// propose_decision
// ============================================

describe("propose_decision tool", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns completeness=complete for a full subgraph without writing", async () => {
    const { propose } = getTools()
    const sg = fullSubgraph()
    const result = await propose({ summary: "s", ...sg })

    expect(result.completeness.complete).toBe(true)
    expect(mockExecuteTransaction).not.toHaveBeenCalled()
  })

  it("flags missing elements for a decision-only subgraph", async () => {
    const { propose } = getTools()
    const result = await propose({
      summary: "s",
      nodes: [{ tempId: "d", name: "D", nodeType: "decision", description: null }],
      edges: [],
    })
    expect(result.completeness.complete).toBe(false)
    expect(result.completeness.missing.length).toBeGreaterThan(0)
  })
})

// ============================================
// commit_decision — happy path, reuse, completeness
// ============================================

describe("commit_decision tool", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("commits a full subgraph and returns completenessScore=100", async () => {
    const built = useTx({ nodeIds: ["nd", "np", "ne", "nc"] })
    const { commit } = getTools()

    const result = expectSuccess(await commit({ summary: "Adopt PG", ...fullSubgraph() }))

    expect(result.committedNodeIds).toHaveLength(4)
    // 3 distinct edges committed
    expect(result.committedEdgeIds).toHaveLength(3)
    expect(result.completenessScore).toBe(100)
    expect(result.completenessMethod).toBe("rule-based")

    // Completeness snapshot persisted on the primary (decision) node metadata.
    const decisionNode = built.insertedNodes.find(
      (n) => n.nodeType === "decision"
    ) as { metadata?: { completeness?: { score?: number } } }
    expect(decisionNode?.metadata?.completeness?.score).toBe(100)
  })

  it("reuses an existing node (existingNodeId) instead of inserting it", async () => {
    useTx({ existingRows: [{ id: "existing-person", nodeType: "person" }], nodeIds: ["nd", "ne", "nc"] })
    const { commit } = getTools()

    const sg = fullSubgraph()
    sg.nodes[1] = { tempId: "p", name: "Eng", nodeType: "person", description: null, existingNodeId: "existing-person" }

    const result = expectSuccess(await commit({ summary: "s", ...sg }))

    // 3 new nodes inserted (person reused), so committedNodeIds excludes the reused one
    expect(result.committedNodeIds).toHaveLength(3)
  })

  it("fails with a friendly message when an existingNodeId does not exist", async () => {
    useTx({ existingRows: [], nodeIds: ["nd"] })
    const { commit } = getTools()

    const result = expectFailure(await commit({
      summary: "s",
      nodes: [
        { tempId: "d", name: "D", nodeType: "decision", description: null },
        { tempId: "p", name: "P", nodeType: "person", description: null, existingNodeId: "missing-id" },
      ],
      edges: [{ sourceTempId: "p", targetTempId: "d", edgeType: "PROPOSED" }],
    }))

    expect(result.error).toContain("Referenced node does not exist")
  })

  it("rejects a reused node whose DB nodeType differs from the declared nodeType", async () => {
    useTx({ existingRows: [{ id: "existing-evidence", nodeType: "evidence" }], nodeIds: ["nd"] })
    const { commit } = getTools()

    const result = expectFailure(await commit({
      summary: "s",
      nodes: [
        { tempId: "d", name: "D", nodeType: "decision", description: null },
        { tempId: "p", name: "P", nodeType: "person", description: null, existingNodeId: "existing-evidence" },
      ],
      edges: [{ sourceTempId: "p", targetTempId: "d", edgeType: "PROPOSED" }],
    }))

    expect(result.error).toContain('is a "evidence" node, not "person"')
  })
})

// ============================================
// commit_decision — primary decision selection (isPrimary)
// ============================================

describe("commit_decision primary selection", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  function withRejectedAlternative(markPrimary: boolean): Pick<CommitDecisionArgs, "nodes" | "edges"> {
    const sg = fullSubgraph()
    return {
      nodes: [
        // Rejected alternative listed FIRST — array order must not decide.
        { tempId: "alt", name: "Use MySQL", nodeType: "decision", description: null },
        ...sg.nodes.map((n) =>
          n.tempId === "d" && markPrimary ? { ...n, isPrimary: true } : n
        ),
      ],
      edges: [
        ...sg.edges,
        { sourceTempId: "p", targetTempId: "alt", edgeType: "REJECTED" },
        { sourceTempId: "alt", targetTempId: "d", edgeType: "COMPARED_AGAINST" },
      ],
    }
  }

  it("persists the completeness snapshot on the isPrimary node, not the first decision node", async () => {
    const built = useTx({ nodeIds: ["nalt", "nd", "np", "ne", "nc"] })
    const { commit } = getTools()

    const result = expectSuccess(await commit({ summary: "s", ...withRejectedAlternative(true) }))

    expect(result.committedNodeIds).toHaveLength(5)
    const withCompleteness = built.insertedNodes.filter(
      (n) => (n.metadata as { completeness?: unknown } | undefined)?.completeness !== undefined
    )
    expect(withCompleteness).toHaveLength(1)
    expect(withCompleteness[0].name).toBe("Adopt PG")
  })

  it("rejects multiple decision nodes when none is marked isPrimary", async () => {
    useTx({ nodeIds: ["n1"] })
    const { commit } = getTools()

    const result = expectFailure(await commit({ summary: "s", ...withRejectedAlternative(false) }))

    expect(result.error).toContain("isPrimary")
    expect(mockExecuteTransaction).not.toHaveBeenCalled()
  })

  it("rejects more than one isPrimary node", async () => {
    useTx({ nodeIds: ["n1"] })
    const { commit } = getTools()

    const sg = withRejectedAlternative(true)
    sg.nodes[0] = { ...sg.nodes[0], isPrimary: true }
    const result = expectFailure(await commit({ summary: "s", ...sg }))

    expect(result.error).toContain("Only one node may set isPrimary")
  })

  it("rejects isPrimary on a non-decision node", async () => {
    useTx({ nodeIds: ["n1"] })
    const { commit } = getTools()

    const sg = fullSubgraph()
    sg.nodes[1] = { ...sg.nodes[1], isPrimary: true }
    const result = expectFailure(await commit({ summary: "s", ...sg }))

    expect(result.error).toContain('isPrimary must be set on a "decision" node')
  })
})

// ============================================
// commit_decision — vocabulary / self-ref / dedup / duplicate-edge
// ============================================

describe("commit_decision guards (Issue #1251)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("rejects an off-vocabulary node type", async () => {
    useTx({ nodeIds: ["n1"] })
    const { commit } = getTools()

    const result = expectFailure(await commit({
      summary: "s",
      nodes: [{ tempId: "d", name: "D", nodeType: "banana", description: null }],
      edges: [],
    }))

    expect(result.error).toContain("Unknown node type")
    // Vocabulary is enforced before any transaction opens.
    expect(mockExecuteTransaction).not.toHaveBeenCalled()
  })

  it("rejects an off-vocabulary edge type", async () => {
    useTx({ nodeIds: ["n1", "n2"] })
    const { commit } = getTools()

    const result = expectFailure(await commit({
      summary: "s",
      nodes: [
        { tempId: "d", name: "D", nodeType: "decision", description: null },
        { tempId: "p", name: "P", nodeType: "person", description: null },
      ],
      edges: [{ sourceTempId: "p", targetTempId: "d", edgeType: "HIGH_FIVED" }],
    }))

    expect(result.error).toContain("Unknown edge type")
  })

  it("rejects a self-referencing edge (same tempId source and target)", async () => {
    useTx({ nodeIds: ["n1"] })
    const { commit } = getTools()

    const result = expectFailure(await commit({
      summary: "s",
      nodes: [{ tempId: "d", name: "D", nodeType: "decision", description: null }],
      edges: [{ sourceTempId: "d", targetTempId: "d", edgeType: "INFLUENCED" }],
    }))

    expect(result.error).toContain("cannot connect to itself")
    expect(mockExecuteTransaction).not.toHaveBeenCalled()
  })

  it("rejects a resolved self-reference: two tempIds reusing the same existingNodeId", async () => {
    const built = useTx({
      existingRows: [{ id: "same-uuid", nodeType: "decision" }],
      nodeIds: [],
    })
    const { commit } = getTools()

    const result = expectFailure(await commit({
      summary: "s",
      nodes: [
        { tempId: "d1", name: "D1", nodeType: "decision", description: null, existingNodeId: "same-uuid", isPrimary: true },
        { tempId: "d2", name: "D2", nodeType: "decision", description: null, existingNodeId: "same-uuid" },
      ],
      edges: [{ sourceTempId: "d1", targetTempId: "d2", edgeType: "PRECEDENT" }],
    }))

    expect(result.error).toContain("cannot connect to itself")
    // Caught at edge resolution — nothing was inserted.
    expect(built.insertedEdges).toHaveLength(0)
  })

  it("deduplicates identical edges in the payload before insert", async () => {
    const built = useTx({ nodeIds: ["nd", "np"] })
    const { commit } = getTools()

    const result = expectSuccess(await commit({
      summary: "s",
      nodes: [
        { tempId: "d", name: "D", nodeType: "decision", description: null },
        { tempId: "p", name: "P", nodeType: "person", description: null },
      ],
      edges: [
        { sourceTempId: "p", targetTempId: "d", edgeType: "PROPOSED" },
        { sourceTempId: "p", targetTempId: "d", edgeType: "PROPOSED" },
      ],
    }))

    // Only ONE PROPOSED edge is actually inserted despite two in the payload.
    expect(built.insertedEdges).toHaveLength(1)
    expect(result.committedEdgeIds).toHaveLength(1)
  })

  function edgeFailureCommit(failEdgeCode: string) {
    useTx({ nodeIds: ["nd", "np"], failEdgeCode })
    const { commit } = getTools()
    return commit({
      summary: "s",
      nodes: [
        { tempId: "d", name: "D", nodeType: "decision", description: null },
        { tempId: "p", name: "P", nodeType: "person", description: null },
      ],
      edges: [{ sourceTempId: "p", targetTempId: "d", edgeType: "PROPOSED" }],
    })
  }

  it("maps a 23505 duplicate-edge DB race to a friendly error (never a raw PG string)", async () => {
    const result = expectFailure(await edgeFailureCommit("23505"))
    expect(result.error).toContain("already exists")
    expect(result.error).not.toMatch(/23505/)
  })

  it("maps a 23503 missing-reference DB error to a friendly error", async () => {
    const result = expectFailure(await edgeFailureCommit("23503"))
    expect(result.error).toContain("no longer exists")
    expect(result.error).not.toMatch(/23503/)
  })

  it("maps a 23514 self-reference DB backstop to a friendly error", async () => {
    const result = expectFailure(await edgeFailureCommit("23514"))
    expect(result.error).toContain("cannot connect to itself")
    expect(result.error).not.toMatch(/23514/)
  })

  it("maps a node-insert constraint violation (class 23) to a friendly error", async () => {
    useTx({ nodeIds: [], failNodeCode: "23502" })
    const { commit } = getTools()

    const result = expectFailure(await commit({
      summary: "s",
      nodes: [{ tempId: "d", name: "D", nodeType: "decision", description: null }],
      edges: [],
    }))

    expect(result.error).toContain("violates a database constraint")
    expect(result.error).not.toMatch(/23502/)
  })

  it("returns a generic message for unmapped errors (no internal detail leaks)", async () => {
    mockExecuteTransaction.mockRejectedValue(new Error("Connection lost to db.internal:5432"))
    const { commit } = getTools()

    const result = expectFailure(await commit({
      summary: "s",
      nodes: [{ tempId: "d", name: "D", nodeType: "decision", description: null }],
      edges: [],
    }))

    expect(result.error).toBe("Failed to capture decision. Please try again.")
    expect(result.error).not.toContain("db.internal")
  })
})
