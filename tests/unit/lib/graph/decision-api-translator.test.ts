import { describe, it, expect, beforeEach } from "@jest/globals"

// ============================================
// Mocks — declared with var for jest.mock hoisting (avoids TDZ)
// ============================================

/* eslint-disable no-var */
var mockGenerateText = jest.fn()
var mockGetRequiredSetting = jest.fn()
var mockGetModelConfig = jest.fn()
var mockCreateProviderModel = jest.fn()
/* eslint-enable no-var */

jest.mock("ai", () => ({
  __esModule: true,
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}))

jest.mock("@/lib/settings-manager", () => ({
  __esModule: true,
  getRequiredSetting: (...args: unknown[]) => mockGetRequiredSetting(...args),
}))

jest.mock("@/lib/ai/model-config", () => ({
  __esModule: true,
  getModelConfig: (...args: unknown[]) => mockGetModelConfig(...args),
}))

jest.mock("@/lib/ai/provider-factory", () => ({
  __esModule: true,
  createProviderModel: (...args: unknown[]) => mockCreateProviderModel(...args),
}))

jest.mock("@/lib/graph/decision-framework", () => {
  const actual = jest.requireActual("@/lib/graph/decision-framework")
  return {
    __esModule: true,
    ...actual,
    getDecisionFrameworkPrompt: jest.fn(() => Promise.resolve("FRAMEWORK PROMPT")),
  }
})

// ============================================
// Imports — after mocks
// ============================================

import {
  translatePayloadToGraph,
  computeRuleBasedScore,
  computeLlmScore,
  type DecisionApiPayload,
  type TranslatedNode,
  type TranslatedEdge,
} from "@/lib/graph/decision-api-translator"

const fakeLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Parameters<typeof computeLlmScore>[3]

// ============================================
// translatePayloadToGraph — mapping
// ============================================

describe("translatePayloadToGraph", () => {
  it("creates a decision node and a person node linked via PROPOSED", () => {
    const payload: DecisionApiPayload = {
      decision: "Adopt PostgreSQL",
      decidedBy: "Eng Team",
    }
    const { nodes, edges } = translatePayloadToGraph(payload, "api")

    const decision = nodes.find((n) => n.nodeType === "decision")
    const person = nodes.find((n) => n.nodeType === "person")
    expect(decision?.name).toBe("Adopt PostgreSQL")
    expect(person?.name).toBe("Eng Team")

    const proposed = edges.find((e) => e.edgeType === "PROPOSED")
    expect(proposed).toBeDefined()
    expect(proposed?.sourceTempId).toBe(person?.tempId)
    expect(proposed?.targetTempId).toBe(decision?.tempId)
  })

  it("returns decisionTempId identifying the primary decision node (even with alternatives)", () => {
    const payload: DecisionApiPayload = {
      decision: "Adopt PostgreSQL",
      decidedBy: "Eng Team",
      alternatives_considered: ["MongoDB", "DynamoDB"],
    }
    const translated = translatePayloadToGraph(payload, "api")

    const primary = translated.nodes.find((n) => n.tempId === translated.decisionTempId)
    expect(primary?.nodeType).toBe("decision")
    expect(primary?.name).toBe("Adopt PostgreSQL")
    // Alternatives are also "decision"-typed but must not be the primary.
    expect(primary?.metadata).not.toHaveProperty("rejected")
  })

  it("maps evidence -> INFORMED, constraints -> CONSTRAINED, conditions -> CONDITION, reasoning -> PART_OF", () => {
    const payload: DecisionApiPayload = {
      decision: "D",
      decidedBy: "P",
      evidence: ["ev1", "ev2"],
      constraints: ["c1"],
      conditions: ["cond1"],
      reasoning: "because",
    }
    const { nodes, edges } = translatePayloadToGraph(payload, "api")

    expect(nodes.filter((n) => n.nodeType === "evidence")).toHaveLength(2)
    expect(nodes.filter((n) => n.nodeType === "constraint")).toHaveLength(1)
    expect(nodes.filter((n) => n.nodeType === "condition")).toHaveLength(1)
    expect(nodes.filter((n) => n.nodeType === "reasoning")).toHaveLength(1)

    expect(edges.filter((e) => e.edgeType === "INFORMED")).toHaveLength(2)
    expect(edges.filter((e) => e.edgeType === "CONSTRAINED")).toHaveLength(1)
    expect(edges.filter((e) => e.edgeType === "CONDITION")).toHaveLength(1)
    expect(edges.filter((e) => e.edgeType === "PART_OF")).toHaveLength(1)
  })

  it("maps alternatives_considered to rejected decision nodes with REJECTED + COMPARED_AGAINST edges", () => {
    const payload: DecisionApiPayload = {
      decision: "D",
      decidedBy: "P",
      alternatives_considered: ["MongoDB"],
    }
    const { nodes, edges } = translatePayloadToGraph(payload, "api")

    const alt = nodes.find((n) => n.name === "MongoDB")
    expect(alt?.nodeType).toBe("decision")
    expect(alt?.metadata).toMatchObject({ rejected: true })

    expect(edges.filter((e) => e.edgeType === "REJECTED")).toHaveLength(1)
    expect(edges.filter((e) => e.edgeType === "COMPARED_AGAINST")).toHaveLength(1)
  })

  it("stamps source=agent and agentId in metadata when agentId is provided", () => {
    const payload: DecisionApiPayload = { decision: "D", decidedBy: "P", agentId: "bot-1" }
    const { nodes } = translatePayloadToGraph(payload, "agent")
    const decision = nodes.find((n) => n.nodeType === "decision")
    expect(decision?.metadata).toMatchObject({ source: "agent", agentId: "bot-1" })
  })

  it("only emits vocabulary node/edge types", () => {
    const payload: DecisionApiPayload = {
      decision: "D",
      decidedBy: "P",
      evidence: ["e"],
      constraints: ["c"],
      conditions: ["cond"],
      reasoning: "r",
      alternatives_considered: ["a"],
    }
    const { nodes, edges } = translatePayloadToGraph(payload, "api")
    const allowedNodes = new Set([
      "decision", "evidence", "constraint", "reasoning", "person", "condition", "request", "policy", "outcome",
    ])
    const allowedEdges = new Set([
      "INFORMED", "LED_TO", "CONSTRAINED", "PROPOSED", "APPROVED_BY", "SUPPORTED_BY", "REPLACED_BY",
      "CHANGED_BY", "PART_OF", "RESULTED_IN", "PRECEDENT", "CONTEXT", "COMPARED_AGAINST", "INFLUENCED",
      "BLOCKED", "WOULD_REQUIRE", "CONDITION", "REJECTED",
      "SUPERSEDED_BY", "SAME_AS", "CONSULTED", "NOTIFIED",
    ])
    for (const n of nodes) expect(allowedNodes.has(n.nodeType)).toBe(true)
    for (const e of edges) expect(allowedEdges.has(e.edgeType)).toBe(true)
  })

  // ============================================
  // Issue #1252 — DACI parties + supersession
  // ============================================

  it("emits CONSULTED / NOTIFIED person nodes (DACI) linked from the decision", () => {
    const payload = {
      decision: "D",
      decidedBy: "Team",
      consulted: ["Legal"],
      notified: ["Board"],
    }
    const { nodes, edges, decisionTempId } = translatePayloadToGraph(payload, "api")

    const persons = nodes.filter((n) => n.nodeType === "person").map((n) => n.name)
    expect(persons).toEqual(expect.arrayContaining(["Team", "Legal", "Board"]))

    const consulted = edges.find((e) => e.edgeType === "CONSULTED")
    const notified = edges.find((e) => e.edgeType === "NOTIFIED")
    expect(consulted?.sourceTempId).toBe(decisionTempId) // decision -> person
    expect(notified?.sourceTempId).toBe(decisionTempId)
  })

  it("emits a reused decision node + SUPERSEDED_BY edge for each supersedes id", () => {
    const oldId = "550e8400-e29b-41d4-a716-446655440000"
    const payload = { decision: "New", decidedBy: "Team", supersedes: [oldId] }
    const { nodes, edges, decisionTempId } = translatePayloadToGraph(payload, "api")

    const reused = nodes.find((n) => n.existingNodeId === oldId)
    expect(reused).toBeDefined()
    expect(reused?.nodeType).toBe("decision")

    const supEdge = edges.find((e) => e.edgeType === "SUPERSEDED_BY")
    expect(supEdge?.sourceTempId).toBe(reused?.tempId) // old (reused) -> new
    expect(supEdge?.targetTempId).toBe(decisionTempId)
  })
})

// ============================================
// computeRuleBasedScore
// ============================================

describe("computeRuleBasedScore", () => {
  function nodesOf(types: string[]): TranslatedNode[] {
    return types.map((t, i) => ({
      tempId: `temp-${i + 1}`,
      name: `n${i}`,
      nodeType: t,
      description: null,
      metadata: {},
    }))
  }

  it("scores 25 for decision-only (person/evidence/condition missing)", () => {
    const nodes = nodesOf(["decision"])
    const result = computeRuleBasedScore(nodes, [])
    expect(result.score).toBe(25)
    expect(result.method).toBe("rule-based")
    expect(result.warnings.length).toBe(3)
  })

  it("scores 100 when all four criteria are satisfied", () => {
    const nodes = nodesOf(["decision", "person", "evidence", "condition"])
    const edges: TranslatedEdge[] = [
      { sourceTempId: "temp-2", targetTempId: "temp-1", edgeType: "PROPOSED" },
      { sourceTempId: "temp-3", targetTempId: "temp-1", edgeType: "INFORMED" },
      { sourceTempId: "temp-4", targetTempId: "temp-1", edgeType: "CONDITION" },
    ]
    const result = computeRuleBasedScore(nodes, edges)
    expect(result.score).toBe(100)
    expect(result.warnings).toEqual([])
  })
})

// ============================================
// computeLlmScore — rule-based authoritative, LLM advisory
// ============================================

describe("computeLlmScore", () => {
  const payload: DecisionApiPayload = { decision: "D", decidedBy: "P" }
  const nodes: TranslatedNode[] = [
    { tempId: "temp-1", name: "D", nodeType: "decision", description: null, metadata: {} },
    { tempId: "temp-2", name: "P", nodeType: "person", description: null, metadata: {} },
  ]
  const edges: TranslatedEdge[] = [
    { sourceTempId: "temp-2", targetTempId: "temp-1", edgeType: "PROPOSED" },
  ]

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetRequiredSetting.mockResolvedValue("decision-model")
    mockGetModelConfig.mockResolvedValue({ provider: "openai", model_id: "gpt-x", id: 1 })
    mockCreateProviderModel.mockResolvedValue({})
  })

  it("returns rule-based score when the model is not configured", async () => {
    mockGetModelConfig.mockResolvedValue(null)
    const result = await computeLlmScore(payload, nodes, edges, fakeLog)
    // decision + person(PROPOSED) => 2 of 4 criteria => 50
    expect(result.score).toBe(50)
    expect(result.method).toBe("rule-based")
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it("keeps the rule-based score authoritative and IGNORES the LLM's score", async () => {
    mockGenerateText.mockResolvedValue({ text: '{"score": 100, "warnings": ["Consider adding a condition"]}' })
    const result = await computeLlmScore(payload, nodes, edges, fakeLog)
    // LLM said 100, but rule-based (50) must win
    expect(result.score).toBe(50)
    expect(result.method).toBe("llm-enhanced")
  })

  it("appends advisory LLM warnings on top of rule-based warnings (deduped)", async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"score": 10, "warnings": ["Consider adding a condition", "No conditions — what would cause this decision to be revisited?"]}',
    })
    const result = await computeLlmScore(payload, nodes, edges, fakeLog)
    // Rule-based warnings already include the "No conditions" line; it must not duplicate.
    expect(result.warnings).toContain("Consider adding a condition")
    const conditionWarnings = result.warnings.filter((w) =>
      w.includes("No conditions")
    )
    expect(conditionWarnings).toHaveLength(1)
  })

  it("falls back to rule-based when the LLM output has no parseable JSON", async () => {
    mockGenerateText.mockResolvedValue({ text: "I could not evaluate this." })
    const result = await computeLlmScore(payload, nodes, edges, fakeLog)
    expect(result.score).toBe(50)
    expect(result.method).toBe("rule-based")
  })

  it("falls back to rule-based when generateText rejects (timeout/abort/provider error)", async () => {
    mockGenerateText.mockRejectedValue(new Error("aborted"))
    const result = await computeLlmScore(payload, nodes, edges, fakeLog)
    expect(result.score).toBe(50)
    expect(result.method).toBe("rule-based")
  })
})
