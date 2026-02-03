/**
 * Decision API Translator
 *
 * Translates structured decision payloads from the external API into
 * graph nodes + edges, and runs completeness validation (rule-based
 * with optional LLM enhancement).
 *
 * Pure functions where possible — no direct DB access. Used by the
 * POST /api/v1/graph/decisions route handler.
 *
 * Part of Epic #674 (External API Platform) - Issue #683
 */

import { generateText } from "ai"
import { createProviderModel } from "@/lib/ai/provider-factory"
import { getModelConfig } from "@/lib/ai/model-config"
import { getRequiredSetting } from "@/lib/settings-manager"
import { getDecisionFrameworkPrompt } from "@/lib/graph/decision-framework"
import {
  validateDecisionCompleteness,
  type DecisionSubgraphNode,
  type DecisionSubgraphEdge,
} from "@/lib/graph/decision-framework"
import type { createLogger } from "@/lib/logger"

// ============================================
// Types
// ============================================

/** Validated input from the API request body */
export interface DecisionApiPayload {
  decision: string
  decidedBy: string
  reasoning?: string
  evidence?: string[]
  constraints?: string[]
  conditions?: string[]
  alternatives_considered?: string[]
  relatedTo?: string[]
  agentId?: string
}

/** A node to be inserted, with a temporary ID for edge wiring */
export interface TranslatedNode {
  tempId: string
  name: string
  nodeType: string
  description: string | null
  metadata: Record<string, unknown>
}

/** An edge between two temp-ID'd nodes */
export interface TranslatedEdge {
  sourceTempId: string
  targetTempId: string
  edgeType: string
}

/** Output of translatePayloadToGraph */
export interface TranslatedDecision {
  nodes: TranslatedNode[]
  edges: TranslatedEdge[]
}

/** Completeness score + warnings */
export interface CompletenessResult {
  score: number
  warnings: string[]
  method: "rule-based" | "llm-enhanced"
}

// ============================================
// Translation
// ============================================

/**
 * Pure function: maps a DecisionApiPayload into graph nodes + edges.
 *
 * Mapping rules:
 * - decision       -> decision node
 * - decidedBy      -> person node  -> PROPOSED edge -> decision
 * - evidence[i]    -> evidence node -> INFORMED edge -> decision
 * - constraints[i] -> constraint node -> CONSTRAINED edge -> decision
 * - reasoning      -> reasoning node -> PART_OF edge -> decision
 * - conditions[i]  -> condition node -> CONDITION edge -> decision
 * - alternatives_considered[i] -> decision node (metadata: {rejected: true})
 *     + person -> REJECTED -> alt
 *     + alt -> COMPARED_AGAINST -> decision
 */
export function translatePayloadToGraph(
  payload: DecisionApiPayload,
  source: "agent" | "api"
): TranslatedDecision {
  const nodes: TranslatedNode[] = []
  const edges: TranslatedEdge[] = []
  let counter = 0

  function nextTempId(): string {
    return `temp-${++counter}`
  }

  const baseMetadata: Record<string, unknown> = { source }
  if (payload.agentId) {
    baseMetadata.agentId = payload.agentId
  }

  // 1. Decision node
  const decisionTempId = nextTempId()
  nodes.push({
    tempId: decisionTempId,
    name: payload.decision,
    nodeType: "decision",
    description: null,
    metadata: { ...baseMetadata },
  })

  // 2. Person node (decidedBy) -> PROPOSED -> decision
  const personTempId = nextTempId()
  nodes.push({
    tempId: personTempId,
    name: payload.decidedBy,
    nodeType: "person",
    description: null,
    metadata: { source: baseMetadata.source },
  })
  edges.push({
    sourceTempId: personTempId,
    targetTempId: decisionTempId,
    edgeType: "PROPOSED",
  })

  // 3. Evidence nodes
  if (payload.evidence) {
    for (const ev of payload.evidence) {
      const evTempId = nextTempId()
      nodes.push({
        tempId: evTempId,
        name: ev,
        nodeType: "evidence",
        description: null,
        metadata: { source: baseMetadata.source },
      })
      edges.push({
        sourceTempId: evTempId,
        targetTempId: decisionTempId,
        edgeType: "INFORMED",
      })
    }
  }

  // 4. Constraint nodes
  if (payload.constraints) {
    for (const c of payload.constraints) {
      const cTempId = nextTempId()
      nodes.push({
        tempId: cTempId,
        name: c,
        nodeType: "constraint",
        description: null,
        metadata: { source: baseMetadata.source },
      })
      edges.push({
        sourceTempId: cTempId,
        targetTempId: decisionTempId,
        edgeType: "CONSTRAINED",
      })
    }
  }

  // 5. Reasoning node (optional)
  if (payload.reasoning) {
    const rTempId = nextTempId()
    nodes.push({
      tempId: rTempId,
      name: payload.reasoning,
      nodeType: "reasoning",
      description: null,
      metadata: { source: baseMetadata.source },
    })
    edges.push({
      sourceTempId: rTempId,
      targetTempId: decisionTempId,
      edgeType: "PART_OF",
    })
  }

  // 6. Condition nodes
  if (payload.conditions) {
    for (const cond of payload.conditions) {
      const condTempId = nextTempId()
      nodes.push({
        tempId: condTempId,
        name: cond,
        nodeType: "condition",
        description: null,
        metadata: { source: baseMetadata.source },
      })
      edges.push({
        sourceTempId: condTempId,
        targetTempId: decisionTempId,
        edgeType: "CONDITION",
      })
    }
  }

  // 7. Alternatives considered (rejected decisions)
  if (payload.alternatives_considered) {
    for (const alt of payload.alternatives_considered) {
      const altTempId = nextTempId()
      nodes.push({
        tempId: altTempId,
        name: alt,
        nodeType: "decision",
        description: null,
        metadata: { source: baseMetadata.source, rejected: true },
      })
      // person -> REJECTED -> alt
      edges.push({
        sourceTempId: personTempId,
        targetTempId: altTempId,
        edgeType: "REJECTED",
      })
      // alt -> COMPARED_AGAINST -> decision
      edges.push({
        sourceTempId: altTempId,
        targetTempId: decisionTempId,
        edgeType: "COMPARED_AGAINST",
      })
    }
  }

  return { nodes, edges }
}

// ============================================
// Completeness Scoring
// ============================================

/**
 * Rule-based score using validateDecisionCompleteness().
 * 4 criteria checked, each worth 25 points.
 * Score = (4 - missing.length) * 25
 */
export function computeRuleBasedScore(
  nodes: TranslatedNode[],
  edges: TranslatedEdge[]
): CompletenessResult {
  const subgraphNodes: DecisionSubgraphNode[] = nodes.map((n) => ({
    id: n.tempId,
    nodeType: n.nodeType,
  }))

  const subgraphEdges: DecisionSubgraphEdge[] = edges.map((e) => ({
    sourceNodeId: e.sourceTempId,
    targetNodeId: e.targetTempId,
    edgeType: e.edgeType,
  }))

  const result = validateDecisionCompleteness(subgraphNodes, subgraphEdges)
  const score = (4 - result.missing.length) * 25

  return {
    score,
    warnings: result.missing,
    method: "rule-based",
  }
}

/**
 * Build the LLM validation prompt from payload + graph summary.
 */
function buildValidationPrompt(
  frameworkPrompt: string,
  payload: DecisionApiPayload,
  nodes: TranslatedNode[],
  edges: TranslatedEdge[],
  ruleResult: CompletenessResult
): string {
  const nodesSummary = nodes.map((n) => `${n.nodeType}: ${n.name}`).join("\n")
  const edgesSummary = edges.map((e) => `${e.sourceTempId} -[${e.edgeType}]-> ${e.targetTempId}`).join("\n")

  return `${frameworkPrompt}

## Validation Task

Evaluate the completeness of this decision capture. Respond with ONLY a JSON object in this exact format:
{"score": <0-100>, "warnings": ["warning1", "warning2"]}

Decision: ${payload.decision}
Decided by: ${payload.decidedBy}
${payload.reasoning ? `Reasoning: ${payload.reasoning}` : ""}
${payload.evidence?.length ? `Evidence: ${payload.evidence.join(", ")}` : ""}
${payload.constraints?.length ? `Constraints: ${payload.constraints.join(", ")}` : ""}
${payload.conditions?.length ? `Conditions: ${payload.conditions.join(", ")}` : ""}
${payload.alternatives_considered?.length ? `Alternatives considered: ${payload.alternatives_considered.join(", ")}` : ""}

Graph nodes:
${nodesSummary}

Graph edges:
${edgesSummary}

Rule-based score: ${ruleResult.score}/100
Rule-based warnings: ${ruleResult.warnings.length > 0 ? ruleResult.warnings.join("; ") : "none"}`
}

/**
 * Parse JSON from LLM response text, returning score + warnings or null if unparseable.
 */
function parseLlmResponse(
  text: string,
  fallback: CompletenessResult
): CompletenessResult | null {
  const jsonMatch = text.trim().match(/{[\S\s]*}/)
  if (!jsonMatch) return null

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { score?: number; warnings?: string[] }
    const score = typeof parsed.score === "number"
      ? Math.min(100, Math.max(0, Math.round(parsed.score)))
      : fallback.score
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((w): w is string => typeof w === "string")
      : fallback.warnings

    return { score, warnings, method: "llm-enhanced" }
  } catch {
    return null
  }
}

/**
 * Attempt LLM-enhanced scoring. Falls back to rule-based on any failure.
 *
 * Resolves model via DECISION_CAPTURE_MODEL setting -> getModelConfig() -> createProviderModel().
 * Uses generateText() with a decision framework prompt + validation suffix.
 * 10s timeout via AbortController.
 */
export async function computeLlmScore(
  payload: DecisionApiPayload,
  nodes: TranslatedNode[],
  edges: TranslatedEdge[],
  log: ReturnType<typeof createLogger>
): Promise<CompletenessResult> {
  const ruleResult = computeRuleBasedScore(nodes, edges)

  try {
    const modelId = await getRequiredSetting("DECISION_CAPTURE_MODEL")
    const modelConfig = await getModelConfig(modelId)
    if (!modelConfig) {
      log.warn("Decision capture model not found, using rule-based score", { modelId })
      return ruleResult
    }

    const model = await createProviderModel(modelConfig.provider, modelConfig.model_id)
    const frameworkPrompt = await getDecisionFrameworkPrompt()
    const prompt = buildValidationPrompt(frameworkPrompt, payload, nodes, edges, ruleResult)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    try {
      const result = await generateText({
        model,
        prompt,
        abortSignal: controller.signal,
      })
      clearTimeout(timeout)

      const llmResult = parseLlmResponse(result.text, ruleResult)
      if (!llmResult) {
        log.warn("LLM response did not contain valid JSON, using rule-based score")
        return ruleResult
      }
      return llmResult
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    log.warn("LLM scoring failed, using rule-based fallback", {
      error: error instanceof Error ? error.message : String(error),
    })
    return ruleResult
  }
}
