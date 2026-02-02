import { describe, it, expect } from "@jest/globals"
import {
  DECISION_NODE_TYPES,
  DECISION_NODE_TYPE_DESCRIPTIONS,
  DECISION_EDGE_TYPES,
  DECISION_EDGE_TYPE_DESCRIPTIONS,
  DECISION_FRAMEWORK_PROMPT,
  isDecisionNodeType,
  isDecisionEdgeType,
  validateDecisionCompleteness,
  type DecisionSubgraphNode,
  type DecisionSubgraphEdge,
} from "@/lib/graph/decision-framework"

// ============================================
// Constants & Type Definitions
// ============================================

describe("Decision Node Types", () => {
  it("should define exactly 9 node types", () => {
    expect(DECISION_NODE_TYPES).toHaveLength(9)
  })

  it("should include all required node types", () => {
    const expected = [
      "decision",
      "evidence",
      "constraint",
      "reasoning",
      "person",
      "condition",
      "request",
      "policy",
      "outcome",
    ]
    expect([...DECISION_NODE_TYPES]).toEqual(expected)
  })

  it("should have a description for every node type", () => {
    for (const nodeType of DECISION_NODE_TYPES) {
      expect(DECISION_NODE_TYPE_DESCRIPTIONS[nodeType]).toBeDefined()
      expect(typeof DECISION_NODE_TYPE_DESCRIPTIONS[nodeType]).toBe("string")
      expect(DECISION_NODE_TYPE_DESCRIPTIONS[nodeType].length).toBeGreaterThan(0)
    }
  })
})

describe("Decision Edge Types", () => {
  it("should define exactly 18 edge types", () => {
    expect(DECISION_EDGE_TYPES).toHaveLength(18)
  })

  it("should include all required edge types", () => {
    const expected = [
      "INFORMED",
      "LED_TO",
      "CONSTRAINED",
      "PROPOSED",
      "APPROVED_BY",
      "SUPPORTED_BY",
      "REPLACED_BY",
      "CHANGED_BY",
      "PART_OF",
      "RESULTED_IN",
      "PRECEDENT",
      "CONTEXT",
      "COMPARED_AGAINST",
      "INFLUENCED",
      "BLOCKED",
      "WOULD_REQUIRE",
      "CONDITION",
      "REJECTED",
    ]
    expect([...DECISION_EDGE_TYPES]).toEqual(expected)
  })

  it("should have a description for every edge type", () => {
    for (const edgeType of DECISION_EDGE_TYPES) {
      expect(DECISION_EDGE_TYPE_DESCRIPTIONS[edgeType]).toBeDefined()
      expect(typeof DECISION_EDGE_TYPE_DESCRIPTIONS[edgeType]).toBe("string")
      expect(DECISION_EDGE_TYPE_DESCRIPTIONS[edgeType].length).toBeGreaterThan(0)
    }
  })
})

// ============================================
// Type Guards
// ============================================

describe("isDecisionNodeType", () => {
  it("should return true for valid node types", () => {
    expect(isDecisionNodeType("decision")).toBe(true)
    expect(isDecisionNodeType("evidence")).toBe(true)
    expect(isDecisionNodeType("person")).toBe(true)
    expect(isDecisionNodeType("condition")).toBe(true)
    expect(isDecisionNodeType("outcome")).toBe(true)
  })

  it("should return false for invalid node types", () => {
    expect(isDecisionNodeType("unknown")).toBe(false)
    expect(isDecisionNodeType("")).toBe(false)
    expect(isDecisionNodeType("Decision")).toBe(false) // case-sensitive
    expect(isDecisionNodeType("DECISION")).toBe(false)
    expect(isDecisionNodeType("node")).toBe(false)
  })
})

describe("isDecisionEdgeType", () => {
  it("should return true for valid edge types", () => {
    expect(isDecisionEdgeType("INFORMED")).toBe(true)
    expect(isDecisionEdgeType("PROPOSED")).toBe(true)
    expect(isDecisionEdgeType("CONDITION")).toBe(true)
    expect(isDecisionEdgeType("REJECTED")).toBe(true)
  })

  it("should return false for invalid edge types", () => {
    expect(isDecisionEdgeType("unknown")).toBe(false)
    expect(isDecisionEdgeType("")).toBe(false)
    expect(isDecisionEdgeType("informed")).toBe(false) // case-sensitive
    expect(isDecisionEdgeType("DECIDES")).toBe(false)
  })
})

// ============================================
// Completeness Validation
// ============================================

describe("validateDecisionCompleteness", () => {
  // Helper to create a complete decision subgraph
  function buildCompleteSubgraph(): {
    nodes: DecisionSubgraphNode[]
    edges: DecisionSubgraphEdge[]
  } {
    const nodes: DecisionSubgraphNode[] = [
      { id: "d1", nodeType: "decision" },
      { id: "p1", nodeType: "person" },
      { id: "e1", nodeType: "evidence" },
      { id: "c1", nodeType: "condition" },
    ]
    const edges: DecisionSubgraphEdge[] = [
      { sourceNodeId: "p1", targetNodeId: "d1", edgeType: "PROPOSED" },
      { sourceNodeId: "e1", targetNodeId: "d1", edgeType: "INFORMED" },
      { sourceNodeId: "c1", targetNodeId: "d1", edgeType: "CONDITION" },
    ]
    return { nodes, edges }
  }

  it("should pass for a complete decision subgraph", () => {
    const { nodes, edges } = buildCompleteSubgraph()
    const result = validateDecisionCompleteness(nodes, edges)

    expect(result.complete).toBe(true)
    expect(result.missing).toHaveLength(0)
  })

  it("should pass with APPROVED_BY instead of PROPOSED", () => {
    const nodes: DecisionSubgraphNode[] = [
      { id: "d1", nodeType: "decision" },
      { id: "p1", nodeType: "person" },
      { id: "e1", nodeType: "evidence" },
      { id: "c1", nodeType: "condition" },
    ]
    const edges: DecisionSubgraphEdge[] = [
      { sourceNodeId: "d1", targetNodeId: "p1", edgeType: "APPROVED_BY" },
      { sourceNodeId: "e1", targetNodeId: "d1", edgeType: "INFORMED" },
      { sourceNodeId: "c1", targetNodeId: "d1", edgeType: "CONDITION" },
    ]
    const result = validateDecisionCompleteness(nodes, edges)

    expect(result.complete).toBe(true)
    expect(result.missing).toHaveLength(0)
  })

  it("should pass with constraint via CONSTRAINED instead of evidence via INFORMED", () => {
    const nodes: DecisionSubgraphNode[] = [
      { id: "d1", nodeType: "decision" },
      { id: "p1", nodeType: "person" },
      { id: "con1", nodeType: "constraint" },
      { id: "c1", nodeType: "condition" },
    ]
    const edges: DecisionSubgraphEdge[] = [
      { sourceNodeId: "p1", targetNodeId: "d1", edgeType: "PROPOSED" },
      { sourceNodeId: "con1", targetNodeId: "d1", edgeType: "CONSTRAINED" },
      { sourceNodeId: "c1", targetNodeId: "d1", edgeType: "CONDITION" },
    ]
    const result = validateDecisionCompleteness(nodes, edges)

    expect(result.complete).toBe(true)
    expect(result.missing).toHaveLength(0)
  })

  it("should fail when no decision node exists", () => {
    const nodes: DecisionSubgraphNode[] = [
      { id: "p1", nodeType: "person" },
      { id: "e1", nodeType: "evidence" },
    ]
    const edges: DecisionSubgraphEdge[] = []
    const result = validateDecisionCompleteness(nodes, edges)

    expect(result.complete).toBe(false)
    expect(result.missing).toContain(
      "No decision node — what was actually decided?"
    )
  })

  it("should fail when no person is connected", () => {
    const nodes: DecisionSubgraphNode[] = [
      { id: "d1", nodeType: "decision" },
      { id: "e1", nodeType: "evidence" },
      { id: "c1", nodeType: "condition" },
    ]
    const edges: DecisionSubgraphEdge[] = [
      { sourceNodeId: "e1", targetNodeId: "d1", edgeType: "INFORMED" },
      { sourceNodeId: "c1", targetNodeId: "d1", edgeType: "CONDITION" },
    ]
    const result = validateDecisionCompleteness(nodes, edges)

    expect(result.complete).toBe(false)
    expect(result.missing).toContain(
      "No person connected — who proposed or approved this decision?"
    )
  })

  it("should fail when a person exists but is not connected via PROPOSED or APPROVED_BY", () => {
    const nodes: DecisionSubgraphNode[] = [
      { id: "d1", nodeType: "decision" },
      { id: "p1", nodeType: "person" },
      { id: "e1", nodeType: "evidence" },
      { id: "c1", nodeType: "condition" },
    ]
    const edges: DecisionSubgraphEdge[] = [
      // Person connected via CONTEXT instead of PROPOSED/APPROVED_BY
      { sourceNodeId: "p1", targetNodeId: "d1", edgeType: "CONTEXT" },
      { sourceNodeId: "e1", targetNodeId: "d1", edgeType: "INFORMED" },
      { sourceNodeId: "c1", targetNodeId: "d1", edgeType: "CONDITION" },
    ]
    const result = validateDecisionCompleteness(nodes, edges)

    expect(result.complete).toBe(false)
    expect(result.missing).toContain(
      "No person connected — who proposed or approved this decision?"
    )
  })

  it("should fail when no evidence or constraint is connected", () => {
    const nodes: DecisionSubgraphNode[] = [
      { id: "d1", nodeType: "decision" },
      { id: "p1", nodeType: "person" },
      { id: "c1", nodeType: "condition" },
    ]
    const edges: DecisionSubgraphEdge[] = [
      { sourceNodeId: "p1", targetNodeId: "d1", edgeType: "PROPOSED" },
      { sourceNodeId: "c1", targetNodeId: "d1", edgeType: "CONDITION" },
    ]
    const result = validateDecisionCompleteness(nodes, edges)

    expect(result.complete).toBe(false)
    expect(result.missing).toContain(
      "No evidence or constraints — what informed this decision?"
    )
  })

  it("should fail when no condition is connected", () => {
    const nodes: DecisionSubgraphNode[] = [
      { id: "d1", nodeType: "decision" },
      { id: "p1", nodeType: "person" },
      { id: "e1", nodeType: "evidence" },
    ]
    const edges: DecisionSubgraphEdge[] = [
      { sourceNodeId: "p1", targetNodeId: "d1", edgeType: "PROPOSED" },
      { sourceNodeId: "e1", targetNodeId: "d1", edgeType: "INFORMED" },
    ]
    const result = validateDecisionCompleteness(nodes, edges)

    expect(result.complete).toBe(false)
    expect(result.missing).toContain(
      "No conditions — what would cause this decision to be revisited?"
    )
  })

  it("should report multiple missing elements at once", () => {
    const nodes: DecisionSubgraphNode[] = []
    const edges: DecisionSubgraphEdge[] = []
    const result = validateDecisionCompleteness(nodes, edges)

    expect(result.complete).toBe(false)
    expect(result.missing).toHaveLength(4)
    expect(result.missing).toContain(
      "No decision node — what was actually decided?"
    )
    expect(result.missing).toContain(
      "No person connected — who proposed or approved this decision?"
    )
    expect(result.missing).toContain(
      "No evidence or constraints — what informed this decision?"
    )
    expect(result.missing).toContain(
      "No conditions — what would cause this decision to be revisited?"
    )
  })

  it("should handle edges referencing nodes not in the subgraph", () => {
    // Edge references a person node that isn't in the node list
    const nodes: DecisionSubgraphNode[] = [
      { id: "d1", nodeType: "decision" },
      { id: "e1", nodeType: "evidence" },
      { id: "c1", nodeType: "condition" },
    ]
    const edges: DecisionSubgraphEdge[] = [
      // p1 not in nodes — PROPOSED edge won't match a person
      { sourceNodeId: "p1", targetNodeId: "d1", edgeType: "PROPOSED" },
      { sourceNodeId: "e1", targetNodeId: "d1", edgeType: "INFORMED" },
      { sourceNodeId: "c1", targetNodeId: "d1", edgeType: "CONDITION" },
    ]
    const result = validateDecisionCompleteness(nodes, edges)

    expect(result.complete).toBe(false)
    expect(result.missing).toContain(
      "No person connected — who proposed or approved this decision?"
    )
  })

  it("should handle a rich subgraph with multiple nodes per type", () => {
    const nodes: DecisionSubgraphNode[] = [
      { id: "d1", nodeType: "decision" },
      { id: "d2", nodeType: "decision" },
      { id: "p1", nodeType: "person" },
      { id: "p2", nodeType: "person" },
      { id: "e1", nodeType: "evidence" },
      { id: "e2", nodeType: "evidence" },
      { id: "con1", nodeType: "constraint" },
      { id: "r1", nodeType: "reasoning" },
      { id: "c1", nodeType: "condition" },
      { id: "c2", nodeType: "condition" },
      { id: "o1", nodeType: "outcome" },
    ]
    const edges: DecisionSubgraphEdge[] = [
      { sourceNodeId: "p1", targetNodeId: "d1", edgeType: "PROPOSED" },
      { sourceNodeId: "d1", targetNodeId: "p2", edgeType: "APPROVED_BY" },
      { sourceNodeId: "e1", targetNodeId: "d1", edgeType: "INFORMED" },
      { sourceNodeId: "e2", targetNodeId: "d1", edgeType: "INFORMED" },
      { sourceNodeId: "con1", targetNodeId: "d1", edgeType: "CONSTRAINED" },
      { sourceNodeId: "r1", targetNodeId: "d1", edgeType: "PART_OF" },
      { sourceNodeId: "c1", targetNodeId: "d1", edgeType: "CONDITION" },
      { sourceNodeId: "c2", targetNodeId: "d2", edgeType: "CONDITION" },
      { sourceNodeId: "d1", targetNodeId: "o1", edgeType: "RESULTED_IN" },
      { sourceNodeId: "d1", targetNodeId: "d2", edgeType: "INFLUENCED" },
    ]
    const result = validateDecisionCompleteness(nodes, edges)

    expect(result.complete).toBe(true)
    expect(result.missing).toHaveLength(0)
  })
})

// ============================================
// LLM Prompt Fragment
// ============================================

describe("DECISION_FRAMEWORK_PROMPT", () => {
  it("should be a non-empty string", () => {
    expect(typeof DECISION_FRAMEWORK_PROMPT).toBe("string")
    expect(DECISION_FRAMEWORK_PROMPT.length).toBeGreaterThan(0)
  })

  it("should mention all node types", () => {
    for (const nodeType of DECISION_NODE_TYPES) {
      expect(DECISION_FRAMEWORK_PROMPT).toContain(`**${nodeType}**`)
    }
  })

  it("should mention all edge types", () => {
    for (const edgeType of DECISION_EDGE_TYPES) {
      expect(DECISION_FRAMEWORK_PROMPT).toContain(`**${edgeType}**`)
    }
  })

  it("should describe the completeness criteria", () => {
    expect(DECISION_FRAMEWORK_PROMPT).toContain("Completeness")
    expect(DECISION_FRAMEWORK_PROMPT).toContain("decision")
    expect(DECISION_FRAMEWORK_PROMPT).toContain("person")
    expect(DECISION_FRAMEWORK_PROMPT).toContain("evidence")
    expect(DECISION_FRAMEWORK_PROMPT).toContain("condition")
  })
})
