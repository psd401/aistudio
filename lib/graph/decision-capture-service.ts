/**
 * Decision Capture Service
 *
 * Shared service for creating structured decision subgraphs.
 * Called by both the REST API (POST /api/v1/graph/decisions)
 * and the MCP capture_decision tool handler.
 *
 * Extracted from route.ts as part of Issue #708 to achieve
 * MCP <-> REST API parity for decision capture.
 */

import { z } from "zod"
import { inArray } from "drizzle-orm"
import {
  translatePayloadToGraph,
  computeLlmScore,
  type DecisionApiPayload,
  type TranslatedDecision,
  type CompletenessResult,
} from "@/lib/graph/decision-api-translator"
import { ErrorFactories } from "@/lib/error-utils"
import { isValidationError } from "@/types/error-types"
import { executeTransaction } from "@/lib/db/drizzle-client"
import { graphNodes, graphEdges } from "@/lib/db/schema"
import { createLogger, sanitizeForLogging } from "@/lib/logger"

// ============================================
// Constants
// ============================================

const METADATA_MAX_BYTES = 10_240

// ============================================
// Validation Schema
// ============================================

const metadataSchema = z.record(z.string(), z.unknown()).refine(
  (val) => JSON.stringify(val).length <= METADATA_MAX_BYTES,
  { message: `Metadata must be ${METADATA_MAX_BYTES} bytes or less when serialized` }
)

export const createDecisionSchema = z.object({
  decision: z.string().trim().min(1, "Decision text is required").max(2000),
  decidedBy: z.string().trim().min(1, "decidedBy is required").max(500),
  reasoning: z.string().trim().max(5000).optional(),
  evidence: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  constraints: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  conditions: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  alternatives_considered: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  relatedTo: z.array(z.string().uuid("Each relatedTo must be a valid UUID")).max(50).optional(),
  agentId: z.string().trim().max(200).optional(),
  metadata: metadataSchema.optional(),
})

export type DecisionPayload = z.infer<typeof createDecisionSchema>

// ============================================
// Result Types
// ============================================

export interface DecisionCaptureResult {
  decisionNodeId: string
  nodesCreated: number
  edgesCreated: number
  completenessScore: number
  completenessMethod: "rule-based" | "llm-enhanced"
  warnings: string[]
}

interface PersistResult {
  decisionNodeId: string
  committedNodeIds: string[]
  committedEdgeIds: string[]
}

// ============================================
// Transaction Helper
// ============================================

async function persistDecisionSubgraph(
  translated: TranslatedDecision,
  payload: DecisionPayload,
  source: string,
  userId: number,
  requestId: string
): Promise<PersistResult> {
  let decisionNodeId = ""
  const committedNodeIds: string[] = []
  const committedEdgeIds: string[] = []
  const log = createLogger({ requestId, operation: "persistDecisionSubgraph" })

  await executeTransaction(async (tx) => {
    // Validate relatedTo inside transaction to prevent race conditions
    if (payload.relatedTo && payload.relatedTo.length > 0) {
      const existingNodes = await tx
        .select({ id: graphNodes.id })
        .from(graphNodes)
        .where(inArray(graphNodes.id, payload.relatedTo))
      const foundIds = new Set(existingNodes.map((n) => n.id))
      const missingIds = payload.relatedTo.filter((id) => !foundIds.has(id))
      if (missingIds.length > 0) {
        throw ErrorFactories.validationFailed([{
          field: "relatedTo",
          message: `Referenced nodes do not exist: ${missingIds.join(", ")}`,
        }])
      }
    }

    const tempIdToRealId = new Map<string, string>()

    // Create nodes sequentially (required by Drizzle transaction pattern)
    for (const node of translated.nodes) {
      const nodeMetadata = node.tempId === "temp-1" && payload.metadata
        ? { ...node.metadata, ...payload.metadata }
        : node.metadata

      const [newNode] = await tx
        .insert(graphNodes)
        .values({
          name: node.name.trim(),
          nodeType: node.nodeType.trim(),
          nodeClass: "decision",
          description: node.description,
          metadata: nodeMetadata,
          createdBy: userId,
        })
        .returning({ id: graphNodes.id })

      tempIdToRealId.set(node.tempId, newNode.id)
      committedNodeIds.push(newNode.id)
      if (node.tempId === "temp-1") decisionNodeId = newNode.id
    }

    // Resolve temp IDs to real IDs for all edges
    const resolvedEdgeValues = translated.edges.map((edge) => {
      const sourceId = tempIdToRealId.get(edge.sourceTempId)
      const targetId = tempIdToRealId.get(edge.targetTempId)
      if (!sourceId || !targetId) {
        throw ErrorFactories.validationFailed([{
          field: "edges",
          message: `Edge references unknown tempId: source=${edge.sourceTempId}, target=${edge.targetTempId}`,
        }])
      }
      return {
        sourceNodeId: sourceId,
        targetNodeId: targetId,
        edgeType: edge.edgeType.trim(),
        metadata: { source },
        createdBy: userId,
      }
    })

    // CONTEXT edges for relatedTo
    if (payload.relatedTo && payload.relatedTo.length > 0) {
      for (const relatedNodeId of payload.relatedTo) {
        resolvedEdgeValues.push({
          sourceNodeId: relatedNodeId,
          targetNodeId: decisionNodeId,
          edgeType: "CONTEXT",
          metadata: { source },
          createdBy: userId,
        })
      }
    }

    // Batch insert all edges at once
    if (resolvedEdgeValues.length > 0) {
      const insertedEdges = await tx
        .insert(graphEdges)
        .values(resolvedEdgeValues)
        .returning({ id: graphEdges.id })

      committedEdgeIds.push(...insertedEdges.map((e) => e.id))
    }

    log.info("Transaction committed", {
      nodesCreated: committedNodeIds.length,
      edgesCreated: committedEdgeIds.length,
    })
  }, "createDecisionSubgraph")

  return { decisionNodeId, committedNodeIds, committedEdgeIds }
}

// ============================================
// Public API
// ============================================

/**
 * Capture a structured decision subgraph.
 *
 * Validates the payload, translates it to graph nodes/edges,
 * persists atomically in a transaction, and computes completeness score.
 *
 * @param payload - Validated decision payload
 * @param userId - ID of the user creating the decision
 * @param requestId - Request correlation ID for logging
 * @returns Decision capture result with node/edge counts and completeness score
 * @throws ValidationError if relatedTo references non-existent nodes
 */
export async function captureStructuredDecision(
  payload: DecisionPayload,
  userId: number,
  requestId: string
): Promise<DecisionCaptureResult> {
  const log = createLogger({ requestId, operation: "captureStructuredDecision" })

  log.info("Decision capture started", {
    decision: sanitizeForLogging(payload.decision),
    decidedBy: sanitizeForLogging(payload.decidedBy),
    relatedToCount: payload.relatedTo?.length ?? 0,
    hasMetadata: !!payload.metadata,
    userId,
  })

  // 1. Translate payload to graph nodes + edges
  const source = payload.agentId ? "agent" : "api"
  const apiPayload: DecisionApiPayload = {
    decision: payload.decision,
    decidedBy: payload.decidedBy,
    reasoning: payload.reasoning,
    evidence: payload.evidence,
    constraints: payload.constraints,
    conditions: payload.conditions,
    alternatives_considered: payload.alternatives_considered,
    relatedTo: payload.relatedTo,
    agentId: payload.agentId,
  }
  const translated = translatePayloadToGraph(apiPayload, source)

  // 2. Persist in transaction (includes relatedTo validation atomically)
  const result = await persistDecisionSubgraph(translated, payload, source, userId, requestId)

  // 3. Compute completeness score (LLM-enhanced with rule-based fallback)
  const completeness = await computeLlmScore(apiPayload, translated.nodes, translated.edges, log)

  log.info("Decision capture completed", {
    decisionNodeId: result.decisionNodeId,
    nodesCreated: result.committedNodeIds.length,
    edgesCreated: result.committedEdgeIds.length,
    completenessScore: completeness.score,
    completenessMethod: completeness.method,
    userId,
  })

  return {
    decisionNodeId: result.decisionNodeId,
    nodesCreated: result.committedNodeIds.length,
    edgesCreated: result.committedEdgeIds.length,
    completenessScore: completeness.score,
    completenessMethod: completeness.method,
    warnings: completeness.warnings,
  }
}
