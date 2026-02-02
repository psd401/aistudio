/**
 * Decision Framework
 *
 * Shared vocabulary and validation rules for decision capture in the context graph.
 * Defines node types, edge types, and completeness criteria that all three capture
 * channels (structured forms, conversational AI, MCP tools) use.
 *
 * These are application-level conventions (not database enums) — the underlying
 * graph_nodes/graph_edges tables accept freeform strings, and this module provides
 * the constrained vocabulary for the decision domain.
 *
 * Part of Epic #675 (Context Graph Decision Capture Layer) - Issue #680
 */

// ============================================
// Decision Node Types
// ============================================

/**
 * Node types used in decision subgraphs.
 * Each type represents a distinct role in the decision-making process.
 */
export const DECISION_NODE_TYPES = [
  "decision",   // The actual decision made
  "evidence",   // Data that informed the decision
  "constraint", // Limiting factor (budget, timeline, policy, etc.)
  "reasoning",  // Intermediate logic or calculation
  "person",     // Who proposed, decided, or approved
  "condition",  // Future trigger for revisiting the decision
  "request",    // The original ask before the decision
  "policy",     // District/board policy referenced
  "outcome",    // What resulted from the decision
] as const

export type DecisionNodeType = typeof DECISION_NODE_TYPES[number]

/**
 * Human-readable descriptions for each node type.
 * Used in UI labels and LLM prompts.
 */
export const DECISION_NODE_TYPE_DESCRIPTIONS: Record<DecisionNodeType, string> = {
  decision:   "The actual decision that was made",
  evidence:   "Data, research, or observations that informed the decision",
  constraint: "A limiting factor such as budget, timeline, or staffing",
  reasoning:  "Intermediate logic, analysis, or calculation",
  person:     "An individual who proposed, made, or approved the decision",
  condition:  "A future trigger that would cause this decision to be revisited",
  request:    "The original ask or problem statement before the decision",
  policy:     "A district or board policy that was referenced",
  outcome:    "The result or consequence of the decision",
}

// ============================================
// Decision Edge Types
// ============================================

/**
 * Edge types that connect nodes in a decision subgraph.
 * Directional: source → edge type → target.
 */
export const DECISION_EDGE_TYPES = [
  "INFORMED",          // evidence/data → decision (this informed that)
  "LED_TO",            // request/reasoning → decision (this led to that)
  "CONSTRAINED",       // constraint → decision (this limited options for that)
  "PROPOSED",          // person → decision (person proposed this)
  "APPROVED_BY",       // decision → person (decision was approved by person)
  "SUPPORTED_BY",      // decision → evidence (decision is supported by this)
  "REPLACED_BY",       // decision → decision (superseded)
  "CHANGED_BY",        // decision → event/condition (modified by this)
  "PART_OF",           // reasoning → decision (this reasoning is part of that decision)
  "RESULTED_IN",       // decision → outcome (decision produced this outcome)
  "PRECEDENT",         // decision → decision (this set precedent for that)
  "CONTEXT",           // any → decision (provides context)
  "COMPARED_AGAINST",  // evidence → evidence (alternatives compared)
  "INFLUENCED",        // decision → decision (influenced but didn't directly cause)
  "BLOCKED",           // constraint → decision (this blocked that option)
  "WOULD_REQUIRE",     // decision → constraint (implementing this would require that)
  "CONDITION",         // condition → decision (this condition applies to that decision)
  "REJECTED",          // person → decision (person rejected this alternative)
] as const

export type DecisionEdgeType = typeof DECISION_EDGE_TYPES[number]

/**
 * Human-readable descriptions for each edge type.
 * Format: "source [edge] target" semantics.
 */
export const DECISION_EDGE_TYPE_DESCRIPTIONS: Record<DecisionEdgeType, string> = {
  INFORMED:         "Source data/evidence informed the target decision",
  LED_TO:           "Source request or reasoning led to the target decision",
  CONSTRAINED:      "Source constraint limited options for the target decision",
  PROPOSED:         "Source person proposed the target decision",
  APPROVED_BY:      "Source decision was approved by the target person",
  SUPPORTED_BY:     "Source decision is supported by the target evidence",
  REPLACED_BY:      "Source decision was superseded by the target decision",
  CHANGED_BY:       "Source decision was modified by the target event or condition",
  PART_OF:          "Source reasoning is part of the target decision process",
  RESULTED_IN:      "Source decision produced the target outcome",
  PRECEDENT:        "Source decision set a precedent for the target decision",
  CONTEXT:          "Source provides context for the target decision",
  COMPARED_AGAINST: "Source evidence was compared against the target evidence",
  INFLUENCED:       "Source decision influenced the target decision",
  BLOCKED:          "Source constraint blocked the target option",
  WOULD_REQUIRE:    "Implementing the source decision would require the target",
  CONDITION:        "Source condition applies to the target decision",
  REJECTED:         "Source person rejected the target decision/alternative",
}

// ============================================
// Type Guards
// ============================================

export function isDecisionNodeType(value: string): value is DecisionNodeType {
  return (DECISION_NODE_TYPES as readonly string[]).includes(value)
}

export function isDecisionEdgeType(value: string): value is DecisionEdgeType {
  return (DECISION_EDGE_TYPES as readonly string[]).includes(value)
}

// ============================================
// Completeness Validation
// ============================================

/**
 * Lightweight node/edge representations for completeness validation.
 * These don't require full SelectGraphNode/SelectGraphEdge — just the fields
 * needed to check structure.
 */
export interface DecisionSubgraphNode {
  id: string
  nodeType: string
}

export interface DecisionSubgraphEdge {
  sourceNodeId: string
  targetNodeId: string
  edgeType: string
}

export interface DecisionCompletenessResult {
  complete: boolean
  missing: string[]
}

/**
 * Validate whether a decision subgraph meets the completeness criteria.
 *
 * A decision subgraph is "complete" when it has:
 * 1. At least one `decision` node
 * 2. At least one `person` node connected via `PROPOSED` or `APPROVED_BY`
 * 3. At least one `evidence` or `constraint` node connected via `INFORMED` or `CONSTRAINED`
 * 4. At least one `condition` node connected via `CONDITION`
 */
export function validateDecisionCompleteness(
  nodes: DecisionSubgraphNode[],
  edges: DecisionSubgraphEdge[]
): DecisionCompletenessResult {
  const missing: string[] = []

  // Build lookup structures
  const nodeTypeById = new Map<string, string>()
  for (const node of nodes) {
    nodeTypeById.set(node.id, node.nodeType)
  }

  // 1. At least one decision node
  const decisionNodes = nodes.filter((n) => n.nodeType === "decision")
  if (decisionNodes.length === 0) {
    missing.push("No decision node — what was actually decided?")
  }

  // 2. At least one person connected via PROPOSED or APPROVED_BY
  const hasPersonConnection = edges.some((edge) => {
    if (edge.edgeType === "PROPOSED") {
      // person → decision: source should be person
      return nodeTypeById.get(edge.sourceNodeId) === "person"
    }
    if (edge.edgeType === "APPROVED_BY") {
      // decision → person: target should be person
      return nodeTypeById.get(edge.targetNodeId) === "person"
    }
    return false
  })
  if (!hasPersonConnection) {
    missing.push("No person connected — who proposed or approved this decision?")
  }

  // 3. At least one evidence or constraint connected via INFORMED or CONSTRAINED
  const hasEvidenceOrConstraint = edges.some((edge) => {
    if (edge.edgeType === "INFORMED") {
      const sourceType = nodeTypeById.get(edge.sourceNodeId)
      return sourceType === "evidence" || sourceType === "constraint"
    }
    if (edge.edgeType === "CONSTRAINED") {
      return nodeTypeById.get(edge.sourceNodeId) === "constraint"
    }
    return false
  })
  if (!hasEvidenceOrConstraint) {
    missing.push("No evidence or constraints — what informed this decision?")
  }

  // 4. At least one condition connected via CONDITION
  const hasCondition = edges.some((edge) => {
    if (edge.edgeType === "CONDITION") {
      return nodeTypeById.get(edge.sourceNodeId) === "condition"
    }
    return false
  })
  if (!hasCondition) {
    missing.push("No conditions — what would cause this decision to be revisited?")
  }

  return {
    complete: missing.length === 0,
    missing,
  }
}

// ============================================
// LLM Prompt Fragment
// ============================================

/**
 * Natural-language prompt fragment describing the decision framework.
 * Include this in system prompts for conversational and MCP-based capture channels
 * so the LLM understands the vocabulary and completeness requirements.
 */
export const DECISION_FRAMEWORK_PROMPT = `You are helping capture decisions in a structured context graph. Every decision should be recorded with enough context to understand it later.

## Node Types
Use these node types when creating graph nodes for decisions:
- **decision** — The actual decision that was made
- **evidence** — Data, research, or observations that informed the decision
- **constraint** — A limiting factor (budget, timeline, staffing, policy compliance, etc.)
- **reasoning** — Intermediate logic, analysis, or calculations
- **person** — An individual who proposed, made, or approved the decision
- **condition** — A future trigger that would cause this decision to be revisited
- **request** — The original ask or problem statement
- **policy** — A district or board policy that was referenced
- **outcome** — The result or consequence of the decision

## Edge Types
Use these edge types to connect nodes:
- **INFORMED** — Evidence/data informed a decision
- **LED_TO** — A request or reasoning led to a decision
- **CONSTRAINED** — A constraint limited options
- **PROPOSED** — A person proposed a decision
- **APPROVED_BY** — A decision was approved by a person
- **SUPPORTED_BY** — A decision is backed by evidence
- **REPLACED_BY** — A decision superseded another
- **CHANGED_BY** — A decision was modified by an event
- **PART_OF** — Reasoning is part of a decision process
- **RESULTED_IN** — A decision produced an outcome
- **PRECEDENT** — One decision set precedent for another
- **CONTEXT** — Something provides context for a decision
- **COMPARED_AGAINST** — Evidence was compared with other evidence
- **INFLUENCED** — One decision influenced another
- **BLOCKED** — A constraint blocked an option
- **WOULD_REQUIRE** — Implementing a decision would require something
- **CONDITION** — A condition applies to a decision
- **REJECTED** — A person rejected an alternative

## Completeness
A decision is considered complete when it has ALL of the following:
1. At least one **decision** node (what was decided)
2. At least one **person** connected via PROPOSED or APPROVED_BY (who made it)
3. At least one **evidence** or **constraint** connected via INFORMED or CONSTRAINED (what informed it)
4. At least one **condition** connected via CONDITION (what would cause revisiting it)

When capturing a decision, proactively ask about any missing elements. For example:
- "Who proposed or approved this?"
- "What data or constraints informed this choice?"
- "Under what conditions should this decision be revisited?"` as const
