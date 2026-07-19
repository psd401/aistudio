import { describe, it, expect, beforeEach } from "@jest/globals"

// ============================================
// Mocks — use global jest for hoisting compatibility
// ============================================

/* eslint-disable no-var */
// Declare with var for hoisting (const/let cause TDZ with jest.mock)
var mockTranslatePayloadToGraph = jest.fn()
var mockComputeLlmScore = jest.fn()
/* eslint-enable no-var */

jest.mock("@/lib/graph/decision-api-translator", () => ({
  __esModule: true,
  translatePayloadToGraph: (...args: unknown[]) => mockTranslatePayloadToGraph(...args),
  computeLlmScore: (...args: unknown[]) => mockComputeLlmScore(...args),
}))

// Mock ErrorFactories so the service can throw validation errors with field messages
jest.mock("@/lib/error-utils", () => ({
  ErrorFactories: {
    validationFailed: (fields: Array<{ field: string; message: string }>) => {
      const msg = fields.map((f) => `${f.field}: ${f.message}`).join("; ")
      return new Error(msg)
    },
  },
}))

// drizzle-client and logger are already mocked globally in jest.setup.js

// ============================================
// Imports — after mocks
// ============================================

import {
  captureStructuredDecision,
  commitDecisionSubgraph,
  createDecisionSchema,
  type DecisionPayload,
} from "@/lib/graph/decision-capture-service"
import { executeTransaction } from "@/lib/db/drizzle-client"
import { generateGraphEmbedding } from "@/lib/graph/graph-embeddings"

// Cast the globally-mocked executeTransaction for per-test control
const mockExecuteTransaction = executeTransaction as jest.MockedFunction<typeof executeTransaction>
// generateGraphEmbedding is globally mocked (jest.setup.js) → deterministic vector.
const mockGenerateEmbedding = generateGraphEmbedding as jest.MockedFunction<typeof generateGraphEmbedding>

// ============================================
// Test Helpers
// ============================================

function createPayload(overrides: Partial<DecisionPayload> = {}): DecisionPayload {
  return {
    decision: "Use PostgreSQL for the data layer",
    decidedBy: "Engineering Team",
    relatedTo: undefined,
    // `supersedes` carries a zod .transform(), so the parsed type always has the
    // key present (string[] | undefined) — mirror that in the manual helper.
    supersedes: undefined,
    ...overrides,
  }
}

function createTranslatedGraph(nodeCount = 2, edgeCount = 1) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    tempId: `temp-${i + 1}`,
    name: `Node ${i + 1}`,
    nodeType: i === 0 ? "decision" : "person",
    description: null,
    metadata: { source: "api" as const },
  }))
  const edges = Array.from({ length: edgeCount }, (_, i) => ({
    sourceTempId: `temp-${i + 2}`,
    targetTempId: "temp-1",
    edgeType: "PROPOSED",
  }))
  return { nodes, edges, decisionTempId: "temp-1" }
}

/** Creates a mock transaction object that tracks insert calls */
function createMockTx(options: {
  nodeIds?: string[]
  edgeIds?: string[]
  existingRelatedNodeIds?: string[]
} = {}) {
  const {
    nodeIds = ["node-uuid-1", "node-uuid-2"],
    edgeIds = ["edge-uuid-1"],
    existingRelatedNodeIds = [],
  } = options

  let nodeInsertCount = 0
  const insertedNodeValues: unknown[] = []
  const insertedEdgeValues: unknown[] = []
  const updateValues: unknown[] = []

  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(
          existingRelatedNodeIds.map((id) => ({ id }))
        ),
      }),
    }),
    // Supersession status update (Issue #1252): tx.update(...).set(...).where(...).
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((vals: unknown) => {
        updateValues.push(vals)
        return { where: jest.fn().mockResolvedValue(undefined) }
      }),
    })),
    // Nodes and edges both arrive as batched arrays; edge rows carry edgeType.
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((vals: unknown) => {
        const rows = vals as Array<Record<string, unknown>>
        if (rows.length > 0 && "edgeType" in rows[0]) {
          insertedEdgeValues.push(...rows)
          return {
            returning: jest.fn().mockResolvedValue(
              rows.map((_, i) => ({ id: edgeIds[i] ?? `edge-uuid-${i + 1}` }))
            ),
          }
        }
        insertedNodeValues.push(...rows)
        const ids = rows.map(() => {
          const nodeId = nodeIds[nodeInsertCount] ?? `node-uuid-${nodeInsertCount + 1}`
          nodeInsertCount++
          return { id: nodeId }
        })
        return { returning: jest.fn().mockResolvedValue(ids) }
      }),
    })),
    _getInsertedNodes: () => insertedNodeValues,
    _getInsertedEdges: () => insertedEdgeValues,
    _getUpdates: () => updateValues,
  }

  return tx
}

/** Standard mock setup for tests that need full orchestration */
function setupMocks(options: {
  nodeCount?: number
  edgeCount?: number
  nodeIds?: string[]
  edgeIds?: string[]
  existingRelatedNodeIds?: string[]
  score?: number
  warnings?: string[]
  method?: "rule-based" | "llm-enhanced"
} = {}) {
  const {
    nodeCount = 2,
    edgeCount = 1,
    score = 50,
    warnings = [],
    method = "rule-based",
    ...txOptions
  } = options

  const translated = createTranslatedGraph(nodeCount, edgeCount)
  mockTranslatePayloadToGraph.mockReturnValue(translated)

  const tx = createMockTx(txOptions)
  mockExecuteTransaction.mockImplementation(async (callback: unknown) => {
    await (callback as (t: unknown) => Promise<void>)(tx)
  })

  mockComputeLlmScore.mockResolvedValue({ score, warnings, method } as never)

  return { translated, tx }
}

// ============================================
// Schema Validation Tests
// ============================================

describe("createDecisionSchema", () => {
  describe("required fields", () => {
    it("should accept valid minimal payload (decision + decidedBy)", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Engineering Team",
      })
      expect(result.success).toBe(true)
    })

    it("should reject missing decision", () => {
      const result = createDecisionSchema.safeParse({
        decidedBy: "Engineering Team",
      })
      expect(result.success).toBe(false)
    })

    it("should reject missing decidedBy", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
      })
      expect(result.success).toBe(false)
    })

    it("should reject empty decision string", () => {
      const result = createDecisionSchema.safeParse({
        decision: "",
        decidedBy: "Engineering Team",
      })
      expect(result.success).toBe(false)
    })

    it("should reject empty decidedBy string", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "",
      })
      expect(result.success).toBe(false)
    })

    it("should trim whitespace from decision", () => {
      const result = createDecisionSchema.safeParse({
        decision: "  Use PostgreSQL  ",
        decidedBy: "Team",
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.decision).toBe("Use PostgreSQL")
      }
    })

    it("should reject whitespace-only decision", () => {
      const result = createDecisionSchema.safeParse({
        decision: "   ",
        decidedBy: "Team",
      })
      expect(result.success).toBe(false)
    })
  })

  describe("string length limits", () => {
    it("should reject decision exceeding 2000 chars", () => {
      const result = createDecisionSchema.safeParse({
        decision: "x".repeat(2001),
        decidedBy: "Team",
      })
      expect(result.success).toBe(false)
    })

    it("should accept decision at exactly 2000 chars", () => {
      const result = createDecisionSchema.safeParse({
        decision: "x".repeat(2000),
        decidedBy: "Team",
      })
      expect(result.success).toBe(true)
    })

    it("should reject decidedBy exceeding 500 chars", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "x".repeat(501),
      })
      expect(result.success).toBe(false)
    })

    it("should reject reasoning exceeding 5000 chars", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        reasoning: "x".repeat(5001),
      })
      expect(result.success).toBe(false)
    })

    it("should reject agentId exceeding 200 chars", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        agentId: "x".repeat(201),
      })
      expect(result.success).toBe(false)
    })
  })

  describe("array fields", () => {
    it("should accept all optional array fields", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        evidence: ["Performance benchmarks show 3x throughput"],
        constraints: ["Budget limited to $500/month"],
        conditions: ["Revisit if data volume exceeds 10TB"],
        alternatives_considered: ["Use MongoDB", "Use DynamoDB"],
      })
      expect(result.success).toBe(true)
    })

    it("should reject arrays exceeding 20 items", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        evidence: Array(21).fill("evidence item"),
      })
      expect(result.success).toBe(false)
    })

    it("should accept arrays at exactly 20 items", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        evidence: Array(20).fill("evidence item"),
      })
      expect(result.success).toBe(true)
    })

    it("should reject empty strings in arrays", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        evidence: ["valid evidence", ""],
      })
      expect(result.success).toBe(false)
    })

    it("should reject array items exceeding 2000 chars", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        evidence: ["x".repeat(2001)],
      })
      expect(result.success).toBe(false)
    })
  })

  describe("relatedTo field", () => {
    it("should accept valid UUIDs", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        relatedTo: ["550e8400-e29b-41d4-a716-446655440000"],
      })
      expect(result.success).toBe(true)
    })

    it("should reject non-UUID strings", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        relatedTo: ["not-a-uuid"],
      })
      expect(result.success).toBe(false)
    })

    it("should reject relatedTo exceeding 50 items", () => {
      const uuids = Array(51).fill("550e8400-e29b-41d4-a716-446655440000")
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        relatedTo: uuids,
      })
      expect(result.success).toBe(false)
    })
  })

  describe("metadata field", () => {
    it("should accept valid metadata object", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        metadata: { project: "ai-studio", sprint: 42 },
      })
      expect(result.success).toBe(true)
    })

    it("should reject metadata exceeding 10KB", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        metadata: { data: "x".repeat(11_000) },
      })
      expect(result.success).toBe(false)
    })

    it("should accept metadata at boundary (10240 bytes)", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL",
        decidedBy: "Team",
        metadata: { d: "x".repeat(10_220) },
      })
      expect(result.success).toBe(true)
    })
  })

  describe("full payload", () => {
    it("should accept a complete payload with all fields", () => {
      const result = createDecisionSchema.safeParse({
        decision: "Use PostgreSQL for the data layer",
        decidedBy: "Engineering Team",
        reasoning: "PostgreSQL provides strong ACID guarantees",
        evidence: ["Benchmark results", "Community support data"],
        constraints: ["Must support JSON queries"],
        conditions: ["Revisit if write throughput exceeds 50k ops/s"],
        alternatives_considered: ["MongoDB", "DynamoDB"],
        relatedTo: ["550e8400-e29b-41d4-a716-446655440000"],
        agentId: "claude-desktop",
        metadata: { epic: "data-platform" },
      })
      expect(result.success).toBe(true)
    })
  })
})

// ============================================
// captureStructuredDecision Tests
// ============================================

describe("captureStructuredDecision", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("orchestration flow", () => {
    it("should translate payload, persist in transaction, and compute score", async () => {
      const { translated, tx } = setupMocks({ score: 75, warnings: ["Missing conditions"] })

      const payload = createPayload()
      const result = await captureStructuredDecision(payload, 1, "req-123")

      expect(mockTranslatePayloadToGraph).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "Use PostgreSQL for the data layer",
          decidedBy: "Engineering Team",
        }),
        "api"
      )

      expect(mockExecuteTransaction).toHaveBeenCalledTimes(1)

      expect(mockComputeLlmScore).toHaveBeenCalledWith(
        expect.objectContaining({ decision: payload.decision }),
        translated.nodes,
        translated.edges,
        expect.anything()
      )

      // decisionNodeId is generated client-side; it must equal the id of the
      // first inserted node (the temp-1 decision node).
      const insertedNodes = tx._getInsertedNodes() as Array<{ id: string }>
      expect(result).toEqual({
        decisionNodeId: insertedNodes[0].id,
        nodesCreated: 2,
        edgesCreated: 1,
        completenessScore: 75,
        completenessMethod: "rule-based",
        warnings: ["Missing conditions"],
      })
    })

    it("should set source to 'agent' when agentId is provided", async () => {
      setupMocks()

      await captureStructuredDecision(createPayload({ agentId: "claude-desktop" }), 1, "req-123")

      expect(mockTranslatePayloadToGraph).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude-desktop" }),
        "agent"
      )
    })

    it("should set source to 'api' when agentId is not provided", async () => {
      setupMocks()

      await captureStructuredDecision(createPayload(), 1, "req-123")

      expect(mockTranslatePayloadToGraph).toHaveBeenCalledWith(
        expect.anything(),
        "api"
      )
    })

    it("should pass all optional fields through to translator", async () => {
      setupMocks({
        nodeCount: 6,
        edgeCount: 5,
        nodeIds: ["n1", "n2", "n3", "n4", "n5", "n6"],
        edgeIds: ["e1", "e2", "e3", "e4", "e5"],
        existingRelatedNodeIds: ["550e8400-e29b-41d4-a716-446655440000"],
        score: 100,
        method: "llm-enhanced",
      })

      const payload = createPayload({
        reasoning: "Strong ACID guarantees",
        evidence: ["Benchmark data"],
        constraints: ["Budget"],
        conditions: ["Revisit at 10TB"],
        alternatives_considered: ["MongoDB"],
        relatedTo: ["550e8400-e29b-41d4-a716-446655440000"],
      })

      const result = await captureStructuredDecision(payload, 42, "req-456")

      expect(mockTranslatePayloadToGraph).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoning: "Strong ACID guarantees",
          evidence: ["Benchmark data"],
          constraints: ["Budget"],
          conditions: ["Revisit at 10TB"],
          alternatives_considered: ["MongoDB"],
          relatedTo: ["550e8400-e29b-41d4-a716-446655440000"],
        }),
        "api"
      )

      expect(result.nodesCreated).toBe(6)
      // 5 translated edges + 1 CONTEXT edge for the relatedTo reference.
      expect(result.edgesCreated).toBe(6)
      expect(result.completenessScore).toBe(100)
      expect(result.completenessMethod).toBe("llm-enhanced")
    })
  })

  describe("transaction persistence", () => {
    it("should batch node inserts into a single statement (plus one edge batch)", async () => {
      const translated = createTranslatedGraph(3, 2)
      mockTranslatePayloadToGraph.mockReturnValue(translated)

      const tx = createMockTx({ nodeIds: ["n1", "n2", "n3"], edgeIds: ["e1", "e2"] })
      mockExecuteTransaction.mockImplementation(async (callback: unknown) => {
        await (callback as (t: unknown) => Promise<void>)(tx)
      })

      mockComputeLlmScore.mockResolvedValue({ score: 50, warnings: [], method: "rule-based" } as never)

      const result = await captureStructuredDecision(createPayload(), 1, "req-123")

      // 1 batched node insert + 1 batched edge insert = 2 insert calls (no N+1).
      expect(tx.insert).toHaveBeenCalledTimes(2)
      expect(result.nodesCreated).toBe(3)
      expect(result.edgesCreated).toBe(2)
    })

    it("should set decisionNodeId to the generated id of the primary (temp-1) node", async () => {
      const { tx } = setupMocks()

      const result = await captureStructuredDecision(createPayload(), 1, "req-123")

      const insertedNodes = tx._getInsertedNodes() as Array<{ id: string; nodeType: string }>
      expect(insertedNodes[0].nodeType).toBe("decision")
      expect(result.decisionNodeId).toBe(insertedNodes[0].id)
      expect(result.decisionNodeId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it("should merge user metadata only onto the primary decision node (temp-1)", async () => {
      const translated = createTranslatedGraph()
      mockTranslatePayloadToGraph.mockReturnValue(translated)

      const tx = createMockTx()
      mockExecuteTransaction.mockImplementation(async (callback: unknown) => {
        await (callback as (t: unknown) => Promise<void>)(tx)
      })
      mockComputeLlmScore.mockResolvedValue({ score: 50, warnings: [], method: "rule-based" } as never)

      const payload = createPayload({ metadata: { project: "ai-studio" } })
      await captureStructuredDecision(payload, 1, "req-123")

      const insertedValues = tx._getInsertedNodes()

      // First node (temp-1 decision) should have merged metadata
      const firstNode = insertedValues[0] as Record<string, unknown>
      const firstMetadata = firstNode.metadata as Record<string, unknown>
      expect(firstMetadata).toHaveProperty("project", "ai-studio")
      expect(firstMetadata).toHaveProperty("source")

      // Second node (temp-2 person) should NOT have user metadata
      const secondNode = insertedValues[1] as Record<string, unknown>
      const secondMetadata = secondNode.metadata as Record<string, unknown>
      expect(secondMetadata).not.toHaveProperty("project")
    })

    it("should not let user metadata overwrite internal provenance keys", async () => {
      const translated = createTranslatedGraph()
      mockTranslatePayloadToGraph.mockReturnValue(translated)

      const tx = createMockTx()
      mockExecuteTransaction.mockImplementation(async (callback: unknown) => {
        await (callback as (t: unknown) => Promise<void>)(tx)
      })
      mockComputeLlmScore.mockResolvedValue({ score: 50, warnings: [], method: "rule-based" } as never)

      // Caller tries to spoof the provenance tag on the primary decision node.
      const payload = createPayload({ metadata: { source: "human-verified" } })
      await captureStructuredDecision(payload, 1, "req-123")

      const firstNode = tx._getInsertedNodes()[0] as Record<string, unknown>
      const firstMetadata = firstNode.metadata as Record<string, unknown>
      expect(firstMetadata.source).toBe("api")
    })

    it("should not merge metadata when payload has no metadata", async () => {
      const translated = createTranslatedGraph()
      mockTranslatePayloadToGraph.mockReturnValue(translated)

      const tx = createMockTx()
      mockExecuteTransaction.mockImplementation(async (callback: unknown) => {
        await (callback as (t: unknown) => Promise<void>)(tx)
      })
      mockComputeLlmScore.mockResolvedValue({ score: 50, warnings: [], method: "rule-based" } as never)

      await captureStructuredDecision(createPayload(), 1, "req-123")

      const firstNode = tx._getInsertedNodes()[0] as Record<string, unknown>
      const firstMetadata = firstNode.metadata as Record<string, unknown>
      // Provenance is written on every agent-authored node (Issue #1252).
      expect(firstMetadata).toEqual({
        source: "api",
        provenance: { extractionMethod: "api", sourceRef: "req-123", confidence: 1 },
      })
    })

    it("should strip caller-supplied metadata.dedup (ER audit key is never caller-writable)", async () => {
      const translated = createTranslatedGraph()
      mockTranslatePayloadToGraph.mockReturnValue(translated)

      const tx = createMockTx()
      mockExecuteTransaction.mockImplementation(async (callback: unknown) => {
        await (callback as (t: unknown) => Promise<void>)(tx)
      })
      mockComputeLlmScore.mockResolvedValue({ score: 50, warnings: [], method: "rule-based" } as never)

      const payload = createPayload({
        metadata: { dedup: { matchedNodeId: "forged-uuid", similarity: 0.99 }, project: "ok" },
      })
      await captureStructuredDecision(payload, 1, "req-123")

      const firstNode = tx._getInsertedNodes()[0] as Record<string, unknown>
      const firstMetadata = firstNode.metadata as Record<string, unknown>
      expect(firstMetadata).not.toHaveProperty("dedup")
      expect(firstMetadata).toHaveProperty("project", "ok")
    })
  })

  describe("relatedTo validation", () => {
    it("should validate relatedTo nodes exist inside the transaction", async () => {
      const relatedId = "550e8400-e29b-41d4-a716-446655440000"
      const { tx } = setupMocks({ existingRelatedNodeIds: [relatedId] })

      const result = await captureStructuredDecision(
        createPayload({ relatedTo: [relatedId] }),
        1,
        "req-123"
      )

      expect(tx.select).toHaveBeenCalled()
      expect(result.decisionNodeId).toBeDefined()
    })

    it("should throw validation error when relatedTo nodes do not exist", async () => {
      setupMocks({ existingRelatedNodeIds: [] })

      const missingId = "550e8400-e29b-41d4-a716-446655440000"

      await expect(
        captureStructuredDecision(createPayload({ relatedTo: [missingId] }), 1, "req-123")
      ).rejects.toThrow(/Referenced nodes do not exist/)
    })

    it("should throw when some but not all relatedTo nodes exist", async () => {
      const existingId = "550e8400-e29b-41d4-a716-446655440001"
      const missingId = "550e8400-e29b-41d4-a716-446655440002"
      setupMocks({ existingRelatedNodeIds: [existingId] })

      await expect(
        captureStructuredDecision(
          createPayload({ relatedTo: [existingId, missingId] }),
          1,
          "req-123"
        )
      ).rejects.toThrow(missingId)
    })

    it("should create CONTEXT edges for valid relatedTo nodes", async () => {
      const relatedId = "550e8400-e29b-41d4-a716-446655440000"
      const translated = createTranslatedGraph()
      mockTranslatePayloadToGraph.mockReturnValue(translated)

      const insertedEdgeValues: unknown[] = []
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ id: relatedId }]),
          }),
        }),
        insert: jest.fn().mockImplementation(() => ({
          values: jest.fn().mockImplementation((vals: unknown) => {
            if (Array.isArray(vals)) insertedEdgeValues.push(...vals)
            return {
              returning: jest.fn().mockResolvedValue(
                Array.isArray(vals)
                  ? vals.map((_, i) => ({ id: `edge-${i}` }))
                  : [{ id: `node-${insertedEdgeValues.length}` }]
              ),
            }
          }),
        })),
      }

      mockExecuteTransaction.mockImplementation(async (callback: unknown) => {
        await (callback as (t: unknown) => Promise<void>)(tx)
      })
      mockComputeLlmScore.mockResolvedValue({ score: 75, warnings: [], method: "rule-based" } as never)

      await captureStructuredDecision(createPayload({ relatedTo: [relatedId] }), 1, "req-123")

      const contextEdges = insertedEdgeValues.filter(
        (e: unknown) => (e as Record<string, unknown>).edgeType === "CONTEXT"
      )
      expect(contextEdges).toHaveLength(1)
      expect(contextEdges[0]).toEqual(
        expect.objectContaining({
          sourceNodeId: relatedId,
          edgeType: "CONTEXT",
        })
      )
    })

    it("should skip relatedTo validation when relatedTo is empty", async () => {
      const { tx } = setupMocks()

      const result = await captureStructuredDecision(createPayload({ relatedTo: [] }), 1, "req-123")

      expect(tx.select).not.toHaveBeenCalled()
      expect(result.decisionNodeId).toBeDefined()
    })

    it("should skip relatedTo validation when relatedTo is undefined", async () => {
      const { tx } = setupMocks()

      const result = await captureStructuredDecision(createPayload(), 1, "req-123")

      expect(tx.select).not.toHaveBeenCalled()
      expect(result.decisionNodeId).toBeDefined()
    })
  })

  describe("completeness scoring", () => {
    it("should forward LLM-enhanced score when available", async () => {
      setupMocks({ score: 85, method: "llm-enhanced" })

      const result = await captureStructuredDecision(createPayload(), 1, "req-123")

      expect(result.completenessScore).toBe(85)
      expect(result.completenessMethod).toBe("llm-enhanced")
      expect(result.warnings).toEqual([])
    })

    it("should forward rule-based score when LLM is unavailable", async () => {
      setupMocks({ score: 50, warnings: ["No conditions provided", "No evidence provided"] })

      const result = await captureStructuredDecision(createPayload(), 1, "req-123")

      expect(result.completenessScore).toBe(50)
      expect(result.completenessMethod).toBe("rule-based")
      expect(result.warnings).toEqual(["No conditions provided", "No evidence provided"])
    })

    it("should include warnings only when present", async () => {
      setupMocks({ score: 100, method: "llm-enhanced" })

      const result = await captureStructuredDecision(createPayload(), 1, "req-123")

      expect(result.warnings).toEqual([])
    })
  })

  describe("error handling", () => {
    it("should propagate transaction errors", async () => {
      mockTranslatePayloadToGraph.mockReturnValue(createTranslatedGraph())
      mockExecuteTransaction.mockRejectedValue(new Error("Connection lost"))

      await expect(
        captureStructuredDecision(createPayload(), 1, "req-123")
      ).rejects.toThrow("Connection lost")
    })

    it("should propagate errors from computeLlmScore", async () => {
      setupMocks()
      mockComputeLlmScore.mockRejectedValue(new Error("LLM service unavailable") as never)

      await expect(
        captureStructuredDecision(createPayload(), 1, "req-123")
      ).rejects.toThrow("LLM service unavailable")
    })

    it("should propagate translation errors", async () => {
      mockTranslatePayloadToGraph.mockImplementation(() => {
        throw new Error("Translation failed")
      })

      await expect(
        captureStructuredDecision(createPayload(), 1, "req-123")
      ).rejects.toThrow("Translation failed")
    })
  })

  describe("result shape", () => {
    it("should return all required fields in DecisionCaptureResult", async () => {
      setupMocks({
        nodeCount: 4,
        edgeCount: 3,
        nodeIds: ["n1", "n2", "n3", "n4"],
        edgeIds: ["e1", "e2", "e3"],
        score: 75,
        warnings: ["Missing conditions"],
      })

      const result = await captureStructuredDecision(createPayload(), 1, "req-123")

      expect(result).toHaveProperty("decisionNodeId")
      expect(result).toHaveProperty("nodesCreated")
      expect(result).toHaveProperty("edgesCreated")
      expect(result).toHaveProperty("completenessScore")
      expect(result).toHaveProperty("completenessMethod")
      expect(result).toHaveProperty("warnings")

      expect(typeof result.decisionNodeId).toBe("string")
      expect(typeof result.nodesCreated).toBe("number")
      expect(typeof result.edgesCreated).toBe("number")
      expect(typeof result.completenessScore).toBe("number")
      expect(["rule-based", "llm-enhanced"]).toContain(result.completenessMethod)
      expect(Array.isArray(result.warnings)).toBe(true)
    })

    it("should count nodes and edges correctly", async () => {
      setupMocks({
        nodeCount: 5,
        edgeCount: 4,
        nodeIds: ["n1", "n2", "n3", "n4", "n5"],
        edgeIds: ["e1", "e2", "e3", "e4"],
      })

      const result = await captureStructuredDecision(createPayload(), 1, "req-123")

      expect(result.nodesCreated).toBe(5)
      expect(result.edgesCreated).toBe(4)
    })
  })

  // ============================================
  // Issue #1251 — vocabulary + self-reference enforcement on the REST/MCP path
  // ============================================

  describe("write-time guards (Issue #1251)", () => {
    beforeEach(() => {
    jest.clearAllMocks()
  })

    it("rejects an off-vocabulary node type before opening a transaction", async () => {
      mockTranslatePayloadToGraph.mockReturnValue({
        nodes: [{ tempId: "temp-1", name: "D", nodeType: "banana", description: null, metadata: { source: "api" } }],
        edges: [],
      })

      await expect(
        captureStructuredDecision(createPayload(), 1, "req-123")
      ).rejects.toThrow(/Unknown node type/)
      expect(mockExecuteTransaction).not.toHaveBeenCalled()
    })

    it("rejects an off-vocabulary edge type", async () => {
      mockTranslatePayloadToGraph.mockReturnValue({
        nodes: [
          { tempId: "temp-1", name: "D", nodeType: "decision", description: null, metadata: { source: "api" } },
          { tempId: "temp-2", name: "P", nodeType: "person", description: null, metadata: { source: "api" } },
        ],
        edges: [{ sourceTempId: "temp-2", targetTempId: "temp-1", edgeType: "HIGH_FIVED" }],
      })

      await expect(
        captureStructuredDecision(createPayload(), 1, "req-123")
      ).rejects.toThrow(/Unknown edge type/)
    })

    it("rejects a self-referencing edge", async () => {
      mockTranslatePayloadToGraph.mockReturnValue({
        nodes: [{ tempId: "temp-1", name: "D", nodeType: "decision", description: null, metadata: { source: "api" } }],
        edges: [{ sourceTempId: "temp-1", targetTempId: "temp-1", edgeType: "INFLUENCED" }],
      })

      await expect(
        captureStructuredDecision(createPayload(), 1, "req-123")
      ).rejects.toThrow(/cannot connect to itself/)
      expect(mockExecuteTransaction).not.toHaveBeenCalled()
    })
  })
})

// ============================================
// createDecisionSchema — relatedTo dedup (Issue #1251)
// ============================================

describe("createDecisionSchema relatedTo dedup", () => {
  it("deduplicates identical relatedTo UUIDs", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000"
    const result = createDecisionSchema.safeParse({
      decision: "Use PostgreSQL",
      decidedBy: "Team",
      relatedTo: [uuid, uuid, uuid],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.relatedTo).toEqual([uuid])
    }
  })

  it("deduplicates case-variant spellings of the same UUID (Postgres uuids are case-insensitive)", () => {
    const lower = "550e8400-e29b-41d4-a716-446655440000"
    const upper = "550E8400-E29B-41D4-A716-446655440000"
    const result = createDecisionSchema.safeParse({
      decision: "Use PostgreSQL",
      decidedBy: "Team",
      relatedTo: [lower, upper],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.relatedTo).toEqual([lower])
    }
  })

  it("preserves distinct relatedTo UUIDs", () => {
    const a = "550e8400-e29b-41d4-a716-446655440001"
    const b = "550e8400-e29b-41d4-a716-446655440002"
    const result = createDecisionSchema.safeParse({
      decision: "Use PostgreSQL",
      decidedBy: "Team",
      relatedTo: [a, b, a],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.relatedTo).toEqual([a, b])
    }
  })
})

// ============================================
// commitDecisionSubgraph — conversational commit path (Issue #1251)
// ============================================

describe("commitDecisionSubgraph", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  /** Mock tx: batched node/edge inserts, discriminated by edgeType on the rows. */
  function commitTx(nodeIds: string[]) {
    let nodeIdx = 0
    const insertedNodes: Array<Record<string, unknown>> = []
    const insertedEdges: Array<Record<string, unknown>> = []
    const tx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((vals: unknown) => {
          const rows = vals as Array<Record<string, unknown>>
          if (rows.length > 0 && "edgeType" in rows[0]) {
            insertedEdges.push(...rows)
            return { returning: jest.fn().mockResolvedValue(rows.map((_, i) => ({ id: `edge-${i}` }))) }
          }
          insertedNodes.push(...rows)
          const ids = rows.map(() => {
            const id = nodeIds[nodeIdx] ?? `node-${nodeIdx + 1}`
            nodeIdx++
            return { id }
          })
          return { returning: jest.fn().mockResolvedValue(ids) }
        }),
      })),
    }
    mockExecuteTransaction.mockImplementation(async (cb: unknown) => {
      await (cb as (t: unknown) => Promise<void>)(tx)
    })
    return { insertedNodes, insertedEdges }
  }

  const fullInput = {
    summary: "Adopt PG",
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

  it("recomputes completeness (100) and persists it on the decision node metadata", async () => {
    const { insertedNodes } = commitTx(["nd", "np", "ne", "nc"])

    const result = await commitDecisionSubgraph(fullInput, 1, "req-1")

    expect(result.completenessScore).toBe(100)
    expect(result.completenessMethod).toBe("rule-based")
    const decisionNode = insertedNodes.find((n) => n.nodeType === "decision") as {
      metadata?: { completeness?: { score?: number } }
    }
    expect(decisionNode?.metadata?.completeness?.score).toBe(100)
  })

  it("deduplicates identical edges before insert", async () => {
    const { insertedEdges } = commitTx(["nd", "np"])

    const result = await commitDecisionSubgraph(
      {
        summary: "s",
        nodes: [
          { tempId: "d", name: "D", nodeType: "decision", description: null },
          { tempId: "p", name: "P", nodeType: "person", description: null },
        ],
        edges: [
          { sourceTempId: "p", targetTempId: "d", edgeType: "PROPOSED" },
          { sourceTempId: "p", targetTempId: "d", edgeType: "PROPOSED" },
        ],
      },
      1,
      "req-1"
    )

    expect(result.committedEdgeIds).toHaveLength(1)
    expect(insertedEdges).toHaveLength(1)
  })

  it("rejects off-vocabulary and self-referencing edges", async () => {
    commitTx(["nd"])
    await expect(
      commitDecisionSubgraph(
        { summary: "s", nodes: [{ tempId: "d", name: "D", nodeType: "decision", description: null }], edges: [{ sourceTempId: "d", targetTempId: "d", edgeType: "INFLUENCED" }] },
        1,
        "req-1"
      )
    ).rejects.toThrow(/cannot connect to itself/)

    await expect(
      commitDecisionSubgraph(
        { summary: "s", nodes: [{ tempId: "d", name: "D", nodeType: "wizard", description: null }], edges: [] },
        1,
        "req-1"
      )
    ).rejects.toThrow(/Unknown node type/)
  })
})

// ============================================
// Issue #1252 — lifecycle status, supersession, provenance, ER warnings
// ============================================

const OLD_DECISION_ID = "99999999-9999-9999-9999-999999999999"

describe("decision lifecycle + supersession + provenance (Issue #1252)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGenerateEmbedding.mockResolvedValue(new Array(512).fill(0.01))
  })

  /** Mock tx that also records tx.update(...).set(...) calls (supersession). */
  function lifecycleTx(reusedRows: Array<{ id: string; nodeType: string }> = []) {
    const insertedNodes: Array<Record<string, unknown>> = []
    const insertedEdges: Array<Record<string, unknown>> = []
    const updates: Array<Record<string, unknown>> = []
    const tx = {
      select: () => ({ from: () => ({ where: () => Promise.resolve(reusedRows) }) }),
      insert: () => ({
        values: (vals: unknown) => {
          const rows = vals as Array<Record<string, unknown>>
          if (rows.length > 0 && "edgeType" in rows[0]) {
            insertedEdges.push(...rows)
            return { returning: () => Promise.resolve(rows.map((_, i) => ({ id: `edge-${i}` }))) }
          }
          insertedNodes.push(...rows)
          return { returning: () => Promise.resolve(rows.map((_, i) => ({ id: `node-${i}` }))) }
        },
      }),
      update: () => ({
        set: (vals: unknown) => {
          updates.push(vals as Record<string, unknown>)
          return { where: () => Promise.resolve(undefined) }
        },
      }),
    }
    mockExecuteTransaction.mockImplementation(async (cb: unknown) => {
      await (cb as (t: unknown) => Promise<void>)(tx)
    })
    return { insertedNodes, insertedEdges, updates }
  }

  it("sets status=superseded + superseded_at on the old node and inserts a SUPERSEDED_BY edge", async () => {
    // Translated subgraph: new decision + person + a REUSED old decision node
    // wired SUPERSEDED_BY -> new (mirrors what the translator emits for supersedes[]).
    mockTranslatePayloadToGraph.mockReturnValue({
      nodes: [
        { tempId: "temp-1", name: "Adopt PG", nodeType: "decision", description: null, metadata: { source: "api" } },
        { tempId: "temp-2", name: "Eng", nodeType: "person", description: null, metadata: { source: "api" } },
        { tempId: "temp-old", name: OLD_DECISION_ID, nodeType: "decision", description: null, metadata: {}, existingNodeId: OLD_DECISION_ID },
      ],
      edges: [
        { sourceTempId: "temp-2", targetTempId: "temp-1", edgeType: "PROPOSED" },
        { sourceTempId: "temp-old", targetTempId: "temp-1", edgeType: "SUPERSEDED_BY" },
      ],
      decisionTempId: "temp-1",
    })
    mockComputeLlmScore.mockResolvedValue({ score: 75, warnings: [], method: "rule-based" } as never)
    const { insertedEdges, updates } = lifecycleTx([{ id: OLD_DECISION_ID, nodeType: "decision" }])

    await captureStructuredDecision(createPayload(), 1, "req-1")

    expect(insertedEdges.some((e) => e.edgeType === "SUPERSEDED_BY")).toBe(true)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ status: "superseded" })
    expect(updates[0].supersededAt).toBeInstanceOf(Date)
  })

  it("does NOT run a status update when there is no SUPERSEDED_BY edge", async () => {
    mockTranslatePayloadToGraph.mockReturnValue(createTranslatedGraph())
    mockComputeLlmScore.mockResolvedValue({ score: 50, warnings: [], method: "rule-based" } as never)
    const { updates } = lifecycleTx()

    await captureStructuredDecision(createPayload(), 1, "req-1")

    expect(updates).toHaveLength(0)
  })

  it("stamps new decision nodes accepted, rejected alternatives rejected, and non-decisions null", async () => {
    mockTranslatePayloadToGraph.mockReturnValue({
      nodes: [
        { tempId: "temp-1", name: "Adopt PG", nodeType: "decision", description: null, metadata: { source: "api" } },
        { tempId: "temp-2", name: "Use Mongo", nodeType: "decision", description: null, metadata: { source: "api", rejected: true } },
        { tempId: "temp-3", name: "Eng", nodeType: "person", description: null, metadata: { source: "api" } },
      ],
      edges: [],
      decisionTempId: "temp-1",
    })
    mockComputeLlmScore.mockResolvedValue({ score: 50, warnings: [], method: "rule-based" } as never)
    const { insertedNodes } = lifecycleTx()

    await captureStructuredDecision(createPayload(), 1, "req-1")

    const byName = (name: string) => insertedNodes.find((n) => n.name === name) as Record<string, unknown>
    expect(byName("Adopt PG").status).toBe("accepted")
    expect(byName("Use Mongo").status).toBe("rejected")
    expect(byName("Eng").status).toBeNull()
  })

  it("writes PROV-O provenance on nodes and edges (extractionMethod=agent when agentId set)", async () => {
    mockTranslatePayloadToGraph.mockReturnValue({
      nodes: [
        { tempId: "temp-1", name: "Adopt PG", nodeType: "decision", description: null, metadata: { source: "agent", agentId: "claude" } },
        { tempId: "temp-2", name: "Eng", nodeType: "person", description: null, metadata: { source: "agent" } },
      ],
      edges: [{ sourceTempId: "temp-2", targetTempId: "temp-1", edgeType: "PROPOSED" }],
      decisionTempId: "temp-1",
    })
    mockComputeLlmScore.mockResolvedValue({ score: 50, warnings: [], method: "rule-based" } as never)
    const { insertedNodes, insertedEdges } = lifecycleTx()

    await captureStructuredDecision(createPayload({ agentId: "claude" }), 7, "req-9")

    const decision = insertedNodes.find((n) => n.nodeType === "decision") as { metadata: Record<string, unknown> }
    expect(decision.metadata.provenance).toEqual({
      extractionMethod: "agent",
      sourceRef: "claude",
      confidence: 1,
    })
    expect((insertedEdges[0].metadata as Record<string, unknown>).provenance).toEqual({
      extractionMethod: "agent",
      sourceRef: "claude",
      confidence: 1,
    })
  })

  it("threads entity-resolution degradation warnings into the result (capture never lost)", async () => {
    mockTranslatePayloadToGraph.mockReturnValue(createTranslatedGraph())
    mockComputeLlmScore.mockResolvedValue({ score: 50, warnings: [], method: "rule-based" } as never)
    lifecycleTx()
    // First (and only, due to short-circuit) embed call fails → ER degrades.
    mockGenerateEmbedding.mockRejectedValueOnce(new Error("Bedrock timeout"))

    const result = await captureStructuredDecision(createPayload(), 1, "req-1")

    expect(result.decisionNodeId).toBeDefined()
    expect(result.warnings.some((w) => /Entity resolution unavailable/.test(w))).toBe(true)
  })
})
