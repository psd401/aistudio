/**
 * Unit tests for decision retrieval (Issue #1252): getDecisionPackage +
 * semanticSearchNodes. executeQuery and generateGraphEmbedding are globally
 * mocked (jest.setup.js); we drive their return values here.
 */
import { describe, it, expect, beforeEach } from "@jest/globals"

import {
  getDecisionPackage,
  semanticSearchNodes,
  DEFAULT_PACKAGE_DEPTH,
  MAX_PACKAGE_DEPTH,
} from "@/lib/graph/decision-retrieval"
import { executeQuery } from "@/lib/db/drizzle-client"
import { generateGraphEmbedding, GRAPH_EMBEDDING_DIMENSIONS } from "@/lib/graph/graph-embeddings"

const mockExecuteQuery = executeQuery as jest.MockedFunction<typeof executeQuery>
const mockGenerateEmbedding = generateGraphEmbedding as jest.MockedFunction<
  typeof generateGraphEmbedding
>

const SEED = "11111111-1111-1111-1111-111111111111"
const OLD = "22222222-2222-2222-2222-222222222222"

function node(id: string, nodeType: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    nodeType,
    nodeClass: "decision",
    description: null,
    status: nodeType === "decision" ? "accepted" : null,
    supersededAt: null,
    metadata: {},
    createdAt: new Date("2026-01-01"),
    ...extra,
  }
}

describe("decision-retrieval", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGenerateEmbedding.mockResolvedValue(new Array(GRAPH_EMBEDDING_DIMENSIONS).fill(0.01))
  })

  describe("getDecisionPackage", () => {
    it("returns null when the seed is not found", async () => {
      mockExecuteQuery.mockResolvedValueOnce([] as never)
      const pkg = await getDecisionPackage(SEED)
      expect(pkg).toBeNull()
    })

    it("assembles the package, groups nodes by type, and derives the supersession chain", async () => {
      mockExecuteQuery
        // 1) reachable CTE
        .mockResolvedValueOnce([
          { id: SEED, depth: 0 },
          { id: "p1", depth: 1 },
          { id: "e1", depth: 1 },
          { id: "c1", depth: 1 },
          { id: OLD, depth: 1 },
        ] as never)
        // 2) node rows
        .mockResolvedValueOnce([
          node(SEED, "decision", "Adopt PostgreSQL"),
          node("p1", "person", "Engineering"),
          node("e1", "evidence", "Benchmarks"),
          node("c1", "condition", "Revisit at 10TB"),
          node(OLD, "decision", "Adopt MySQL", { status: "superseded" }),
        ] as never)
        // 3) internal edges
        .mockResolvedValueOnce([
          { id: "ed1", sourceNodeId: "p1", targetNodeId: SEED, edgeType: "PROPOSED" },
          { id: "ed2", sourceNodeId: "e1", targetNodeId: SEED, edgeType: "INFORMED" },
          { id: "ed3", sourceNodeId: "c1", targetNodeId: SEED, edgeType: "CONDITION" },
          { id: "ed4", sourceNodeId: OLD, targetNodeId: SEED, edgeType: "SUPERSEDED_BY" },
        ] as never)

      const pkg = await getDecisionPackage(SEED)
      expect(pkg).not.toBeNull()
      expect(pkg!.decision.id).toBe(SEED)
      expect(pkg!.persons.map((n) => n.id)).toEqual(["p1"])
      expect(pkg!.evidence.map((n) => n.id)).toEqual(["e1"])
      expect(pkg!.conditions.map((n) => n.id)).toEqual(["c1"])
      expect(pkg!.nodes).toHaveLength(5)
      expect(pkg!.edges).toHaveLength(4)
      expect(pkg!.supersessionChain).toEqual([
        { supersededId: OLD, supersededById: SEED },
      ])
      expect(pkg!.depth).toBe(DEFAULT_PACKAGE_DEPTH)
    })

    it("clamps depth to the allowed maximum", async () => {
      mockExecuteQuery
        .mockResolvedValueOnce([{ id: SEED, depth: 0 }] as never)
        .mockResolvedValueOnce([node(SEED, "decision", "D")] as never)
        .mockResolvedValueOnce([] as never)

      const pkg = await getDecisionPackage(SEED, { maxDepth: 99 })
      expect(pkg!.depth).toBe(MAX_PACKAGE_DEPTH)
    })
  })

  describe("semanticSearchNodes", () => {
    it("embeds the query and maps similarity rows", async () => {
      mockExecuteQuery.mockResolvedValueOnce([
        {
          id: SEED,
          name: "Adopt PostgreSQL",
          node_type: "decision",
          node_class: "decision",
          description: "chose PG",
          status: "accepted",
          similarity: 0.88,
        },
      ] as never)

      const matches = await semanticSearchNodes("switch our database to Postgres", {
        nodeType: "decision",
      })

      expect(mockGenerateEmbedding).toHaveBeenCalledWith("switch our database to Postgres")
      expect(matches).toEqual([
        {
          id: SEED,
          name: "Adopt PostgreSQL",
          nodeType: "decision",
          nodeClass: "decision",
          description: "chose PG",
          status: "accepted",
          similarity: 0.88,
        },
      ])
    })

    it("throws when the embedding call fails (caller falls back to lexical)", async () => {
      mockGenerateEmbedding.mockRejectedValue(new Error("Bedrock down"))
      await expect(semanticSearchNodes("anything")).rejects.toThrow(/Bedrock down/)
    })
  })
})
