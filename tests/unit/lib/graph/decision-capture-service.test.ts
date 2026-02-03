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
  createDecisionSchema,
  type DecisionPayload,
} from "@/lib/graph/decision-capture-service"
import { executeTransaction } from "@/lib/db/drizzle-client"

// Cast the globally-mocked executeTransaction for per-test control
const mockExecuteTransaction = executeTransaction as jest.MockedFunction<typeof executeTransaction>

// ============================================
// Test Helpers
// ============================================

function createPayload(overrides: Partial<DecisionPayload> = {}): DecisionPayload {
  return {
    decision: "Use PostgreSQL for the data layer",
    decidedBy: "Engineering Team",
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
  return { nodes, edges }
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

  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(
          existingRelatedNodeIds.map((id) => ({ id }))
        ),
      }),
    }),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((vals: unknown) => {
        if (Array.isArray(vals)) {
          insertedEdgeValues.push(...vals)
          return {
            returning: jest.fn().mockResolvedValue(
              edgeIds.map((id) => ({ id }))
            ),
          }
        }
        insertedNodeValues.push(vals)
        const nodeId = nodeIds[nodeInsertCount] ?? `node-uuid-${nodeInsertCount + 1}`
        nodeInsertCount++
        return {
          returning: jest.fn().mockResolvedValue([{ id: nodeId }]),
        }
      }),
    })),
    _getInsertedNodes: () => insertedNodeValues,
    _getInsertedEdges: () => insertedEdgeValues,
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
      const { translated } = setupMocks({ score: 75, warnings: ["Missing conditions"] })

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

      expect(result).toEqual({
        decisionNodeId: "node-uuid-1",
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
      expect(result.edgesCreated).toBe(5)
      expect(result.completenessScore).toBe(100)
      expect(result.completenessMethod).toBe("llm-enhanced")
    })
  })

  describe("transaction persistence", () => {
    it("should create nodes sequentially in transaction", async () => {
      const translated = createTranslatedGraph(3, 2)
      mockTranslatePayloadToGraph.mockReturnValue(translated)

      const insertCalls: string[] = []
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        }),
        insert: jest.fn().mockImplementation(() => {
          insertCalls.push("insert")
          return {
            values: jest.fn().mockImplementation((vals: unknown) => {
              if (Array.isArray(vals)) {
                return { returning: jest.fn().mockResolvedValue(vals.map((_, i) => ({ id: `edge-${i}` }))) }
              }
              const idx = insertCalls.length
              return { returning: jest.fn().mockResolvedValue([{ id: `node-${idx}` }]) }
            }),
          }
        }),
      }

      mockExecuteTransaction.mockImplementation(async (callback: unknown) => {
        await (callback as (t: unknown) => Promise<void>)(tx)
      })

      mockComputeLlmScore.mockResolvedValue({ score: 50, warnings: [], method: "rule-based" } as never)

      const result = await captureStructuredDecision(createPayload(), 1, "req-123")

      // 3 node inserts + 1 batch edge insert = 4 total insert calls
      expect(tx.insert).toHaveBeenCalledTimes(4)
      expect(result.nodesCreated).toBe(3)
    })

    it("should set decisionNodeId from the first node (temp-1)", async () => {
      setupMocks({ nodeIds: ["decision-uuid-abc", "person-uuid-def"] })

      const result = await captureStructuredDecision(createPayload(), 1, "req-123")

      expect(result.decisionNodeId).toBe("decision-uuid-abc")
    })

    it("should merge user metadata only onto the primary decision node (temp-1)", async () => {
      const translated = createTranslatedGraph()
      mockTranslatePayloadToGraph.mockReturnValue(translated)

      const insertedValues: unknown[] = []
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        }),
        insert: jest.fn().mockImplementation(() => ({
          values: jest.fn().mockImplementation((vals: unknown) => {
            if (!Array.isArray(vals)) insertedValues.push(vals)
            return {
              returning: jest.fn().mockResolvedValue([{ id: `id-${insertedValues.length}` }]),
            }
          }),
        })),
      }

      mockExecuteTransaction.mockImplementation(async (callback: unknown) => {
        await (callback as (t: unknown) => Promise<void>)(tx)
      })
      mockComputeLlmScore.mockResolvedValue({ score: 50, warnings: [], method: "rule-based" } as never)

      const payload = createPayload({ metadata: { project: "ai-studio" } })
      await captureStructuredDecision(payload, 1, "req-123")

      // First node (temp-1 decision) should have merged metadata
      const firstNode = insertedValues[0] as Record<string, unknown>
      const firstMetadata = firstNode.metadata as Record<string, unknown>
      expect(firstMetadata).toHaveProperty("project", "ai-studio")
      expect(firstMetadata).toHaveProperty("source")

      // Second node (temp-2 person) should NOT have user metadata
      if (insertedValues.length > 1) {
        const secondNode = insertedValues[1] as Record<string, unknown>
        const secondMetadata = secondNode.metadata as Record<string, unknown>
        expect(secondMetadata).not.toHaveProperty("project")
      }
    })

    it("should not merge metadata when payload has no metadata", async () => {
      const translated = createTranslatedGraph()
      mockTranslatePayloadToGraph.mockReturnValue(translated)

      const insertedValues: unknown[] = []
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        }),
        insert: jest.fn().mockImplementation(() => ({
          values: jest.fn().mockImplementation((vals: unknown) => {
            if (!Array.isArray(vals)) insertedValues.push(vals)
            return {
              returning: jest.fn().mockResolvedValue([{ id: `id-${insertedValues.length}` }]),
            }
          }),
        })),
      }

      mockExecuteTransaction.mockImplementation(async (callback: unknown) => {
        await (callback as (t: unknown) => Promise<void>)(tx)
      })
      mockComputeLlmScore.mockResolvedValue({ score: 50, warnings: [], method: "rule-based" } as never)

      await captureStructuredDecision(createPayload(), 1, "req-123")

      const firstNode = insertedValues[0] as Record<string, unknown>
      const firstMetadata = firstNode.metadata as Record<string, unknown>
      expect(firstMetadata).toEqual({ source: "api" })
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
})
