/**
 * Unit tests for entity resolution (Issue #1252).
 *
 * `generateGraphEmbedding` is globally mocked (jest.setup.js) to a deterministic
 * 512-dim vector, and `executeQuery` (used by findSimilarNodes) is globally
 * mocked — we drive the similarity bands by controlling what executeQuery
 * returns, since the embedding vector itself does not affect the band logic.
 */
import { describe, it, expect, beforeEach } from "@jest/globals"

import {
  resolveEntities,
  findSimilarNodes,
  ER_AUTO_REUSE_THRESHOLD,
  ER_CANDIDATE_THRESHOLD,
  type ResolvableNode,
} from "@/lib/graph/entity-resolution"
import { executeQuery } from "@/lib/db/drizzle-client"
import { generateGraphEmbedding, GRAPH_EMBEDDING_DIMENSIONS } from "@/lib/graph/graph-embeddings"

const mockExecuteQuery = executeQuery as jest.MockedFunction<typeof executeQuery>
const mockGenerateEmbedding = generateGraphEmbedding as jest.MockedFunction<
  typeof generateGraphEmbedding
>

const fakeVector = () => new Array(GRAPH_EMBEDDING_DIMENSIONS).fill(0.01)

function personNode(overrides: Partial<ResolvableNode> = {}): ResolvableNode {
  return { tempId: "p1", name: "Technology Committee", nodeType: "person", ...overrides }
}

describe("entity-resolution", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGenerateEmbedding.mockResolvedValue(fakeVector())
    mockExecuteQuery.mockResolvedValue([] as never)
  })

  describe("thresholds", () => {
    it("exposes the documented bands", () => {
      expect(ER_AUTO_REUSE_THRESHOLD).toBe(0.9)
      expect(ER_CANDIDATE_THRESHOLD).toBe(0.75)
    })
  })

  describe("resolveEntities — auto-reuse (>= 0.90)", () => {
    it("reuses the existing node, records dedup metadata, and warns", async () => {
      mockExecuteQuery.mockResolvedValue([
        { id: "existing-1", name: "Tech Committee", similarity: 0.95 },
      ] as never)

      const node = personNode()
      const result = await resolveEntities([node], { requestId: "req-1" })

      expect(node.existingNodeId).toBe("existing-1")
      expect(node.embedding).toBeUndefined() // reused → no new embedding written
      expect(node.metadata?.dedup).toEqual({ matchedNodeId: "existing-1", similarity: 0.95 })
      expect(result.reused).toBe(1)
      expect(result.degraded).toBe(false)
      expect(result.warnings.join(" ")).toMatch(/Reused existing person/)
    })
  })

  describe("resolveEntities — candidate band (0.75–0.90)", () => {
    it("creates a new node, stores its embedding, and surfaces candidates", async () => {
      mockExecuteQuery.mockResolvedValue([
        { id: "cand-1", name: "Technology Cmte", similarity: 0.82 },
      ] as never)

      const node = personNode()
      const result = await resolveEntities([node], { requestId: "req-1" })

      expect(node.existingNodeId).toBeUndefined()
      expect(node.embedding).toHaveLength(GRAPH_EMBEDDING_DIMENSIONS)
      expect(node.metadata?.dedup).toBeUndefined()
      expect(result.reused).toBe(0)
      expect(result.warnings.join(" ")).toMatch(/Possible duplicate person/)
      expect(result.warnings.join(" ")).toMatch(/cand-1/)
    })
  })

  describe("resolveEntities — below threshold (< 0.75)", () => {
    it("creates silently (no warning) but still stores the embedding", async () => {
      mockExecuteQuery.mockResolvedValue([
        { id: "far-1", name: "Unrelated", similarity: 0.4 },
      ] as never)

      const node = personNode()
      const result = await resolveEntities([node], { requestId: "req-1" })

      expect(node.existingNodeId).toBeUndefined()
      expect(node.embedding).toHaveLength(GRAPH_EMBEDDING_DIMENSIONS)
      expect(result.warnings).toHaveLength(0)
    })
  })

  describe("resolveEntities — type gating", () => {
    it("embeds decision nodes but never auto-reuses them (not an ER type)", async () => {
      // Even a 0.99 match must not merge a decision node.
      mockExecuteQuery.mockResolvedValue([
        { id: "d-existing", name: "Other decision", similarity: 0.99 },
      ] as never)

      const node: ResolvableNode = { tempId: "d1", name: "Adopt PG", nodeType: "decision" }
      const result = await resolveEntities([node], { requestId: "req-1" })

      expect(node.embedding).toHaveLength(GRAPH_EMBEDDING_DIMENSIONS)
      expect(node.existingNodeId).toBeUndefined()
      expect(result.reused).toBe(0)
      // No similarity search is run for non-ER types.
      expect(mockExecuteQuery).not.toHaveBeenCalled()
    })

    it("skips non-embeddable types entirely (no embed, no reuse)", async () => {
      const node: ResolvableNode = { tempId: "c1", name: "Budget", nodeType: "constraint" }
      const result = await resolveEntities([node], { requestId: "req-1" })

      expect(node.embedding).toBeUndefined()
      expect(mockGenerateEmbedding).not.toHaveBeenCalled()
      expect(result.warnings).toHaveLength(0)
    })

    it("leaves already-reused nodes (existingNodeId set) untouched", async () => {
      const node = personNode({ existingNodeId: "preset-1" })
      const result = await resolveEntities([node], { requestId: "req-1" })

      expect(node.embedding).toBeUndefined()
      expect(mockGenerateEmbedding).not.toHaveBeenCalled()
      expect(result.reused).toBe(0)
    })
  })

  describe("resolveEntities — graceful degradation", () => {
    it("degrades to no-dedup when embedding fails; node is not lost", async () => {
      mockGenerateEmbedding.mockRejectedValue(new Error("Bedrock timeout"))

      const node = personNode()
      const result = await resolveEntities([node], { requestId: "req-1" })

      expect(result.degraded).toBe(true)
      expect(node.existingNodeId).toBeUndefined()
      expect(node.embedding).toBeUndefined()
      expect(result.warnings.join(" ")).toMatch(/Entity resolution unavailable/)
    })

    it("short-circuits: only one embed attempt after a failure", async () => {
      mockGenerateEmbedding.mockRejectedValue(new Error("Bedrock down"))

      const nodes = [personNode({ tempId: "p1" }), personNode({ tempId: "p2", name: "Board" })]
      await resolveEntities(nodes, { requestId: "req-1" })

      expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1)
    })

    it("a similarity-search error degrades only that node, keeps the capture", async () => {
      mockExecuteQuery.mockRejectedValue(new Error("db error"))

      const node = personNode()
      const result = await resolveEntities([node], { requestId: "req-1" })

      // Embedding still stored (search failed after embed); node created, no reuse.
      expect(node.embedding).toHaveLength(GRAPH_EMBEDDING_DIMENSIONS)
      expect(node.existingNodeId).toBeUndefined()
      expect(result.reused).toBe(0)
    })
  })

  describe("findSimilarNodes", () => {
    it("maps rows to id/name/similarity", async () => {
      mockExecuteQuery.mockResolvedValue([
        { id: "n1", name: "A", similarity: 0.9 },
        { id: "n2", name: "B", similarity: 0.8 },
      ] as never)

      const matches = await findSimilarNodes(fakeVector(), "person")
      expect(matches).toEqual([
        { id: "n1", name: "A", similarity: 0.9 },
        { id: "n2", name: "B", similarity: 0.8 },
      ])
    })
  })
})
