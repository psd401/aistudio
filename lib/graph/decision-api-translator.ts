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

import { z } from "zod"
import { generateText } from "ai"
import { createProviderModel } from "@/lib/ai/provider-factory"
import { getModelConfig } from "@/lib/ai/model-config"
import { getRequiredSetting } from "@/lib/settings-manager"
import { getDecisionFrameworkPrompt } from "@/lib/graph/decision-framework"
import { scoreDecisionSubgraph } from "@/lib/graph/decision-framework"
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
  /**
   * If set, this node links to an existing graph node (by UUID) instead of
   * creating a new one. Used by the conversational capture channel
   * (commit_decision) so the shared persist path can reuse nodes. The REST/MCP
   * translator never sets this — it always mints fresh nodes.
   */
  existingNodeId?: string
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
  /**
   * tempId of the primary decision node. Callers must use this (never a
   * hardcoded literal) to identify the decision node — it stays correct even if
   * the emission order of translatePayloadToGraph changes.
   */
  decisionTempId: string
}

/**
 * Completeness score + warnings.
 *
 * `score` is ALWAYS the deterministic rule-based score — it is authoritative and
 * auditable (Issue #1251). `method` reflects whether the optional LLM pass ran:
 * "llm-enhanced" means the LLM appended advisory warnings/insights on top of the
 * rule-based `warnings`; the LLM never changes the numeric score.
 */
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

  return { nodes, edges, decisionTempId }
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
  const { score, warnings } = scoreDecisionSubgraph(nodes, edges)
  return { score, warnings, method: "rule-based" }
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
 * Zod shape for the LLM's JSON reply. The `score` field is accepted for
 * backward-compatible parsing but intentionally IGNORED — the rule-based score
 * is authoritative (Issue #1251). Only `warnings` (advisory) are surfaced.
 */
const llmResponseSchema = z.object({
  score: z.number().optional(),
  warnings: z.array(z.string()).optional(),
})

/**
 * Parse ADVISORY feedback from the LLM response text. Returns the LLM's
 * warnings/insights, or null if the text contains no parseable JSON object.
 *
 * The LLM's numeric score is deliberately dropped here: the deterministic
 * rule-based score remains authoritative and auditable. The LLM can only add
 * qualitative warnings on top of it.
 */
function parseLlmAdvisory(text: string): { warnings: string[] } | null {
  const jsonMatch = text.trim().match(/{[\S\s]*}/)
  if (!jsonMatch) return null

  try {
    const parsed = llmResponseSchema.safeParse(JSON.parse(jsonMatch[0]))
    if (!parsed.success) return null
    return { warnings: parsed.data.warnings ?? [] }
  } catch {
    return null
  }
}

/**
 * Compute the completeness score, optionally augmenting the rule-based warnings
 * with advisory LLM feedback.
 *
 * The returned `score` is ALWAYS the deterministic rule-based score — the LLM
 * NEVER overrides it (Issue #1251, DoD: "rule-based score is authoritative; LLM
 * enhancement only appends advisory warnings/insights"). When the DECISION_CAPTURE_MODEL
 * setting resolves, the LLM pass runs (10s timeout via AbortController) and any
 * new warnings it returns are appended (deduped). On any failure — missing model,
 * unparseable output, timeout, provider error — the rule-based result is returned
 * unchanged. LLM scoring never blocks or fails a capture.
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
        maxOutputTokens: 200,
      })
      clearTimeout(timeout)

      const advisory = parseLlmAdvisory(result.text)
      if (!advisory) {
        log.warn("LLM response did not contain valid JSON, using rule-based score")
        return ruleResult
      }

      // Rule-based score stays authoritative; append advisory LLM warnings (deduped).
      const warnings = [...ruleResult.warnings]
      for (const w of advisory.warnings) {
        if (w && !warnings.includes(w)) warnings.push(w)
      }
      return { score: ruleResult.score, warnings, method: "llm-enhanced" }
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
