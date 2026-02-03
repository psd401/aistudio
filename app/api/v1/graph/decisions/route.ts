/**
 * Graph Decisions Collection Endpoint
 * POST /api/v1/graph/decisions — Create a structured decision subgraph
 * Part of Epic #674 (External API Platform) - Issue #683
 */

import { NextRequest } from "next/server"
import { z } from "zod"
import { inArray } from "drizzle-orm"
import { withApiAuth, requireScope, createApiResponse, createErrorResponse } from "@/lib/api"
import {
  translatePayloadToGraph,
  computeLlmScore,
  type DecisionApiPayload,
  type TranslatedDecision,
} from "@/lib/graph/decision-api-translator"
import { ErrorFactories } from "@/lib/error-utils"
import { executeTransaction } from "@/lib/db/drizzle-client"
import { graphNodes, graphEdges } from "@/lib/db/schema"
import { createLogger } from "@/lib/logger"

// ============================================
// Validation Schema
// ============================================

const metadataSchema = z.record(z.string(), z.unknown()).refine(
  (val) => JSON.stringify(val).length <= 10_240,
  { message: "Metadata must be 10KB or less when serialized" }
)

const createDecisionSchema = z.object({
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

type ValidatedPayload = z.infer<typeof createDecisionSchema>

// ============================================
// Transaction Helper
// ============================================

interface PersistResult {
  decisionNodeId: string
  committedNodeIds: string[]
  committedEdgeIds: string[]
}

async function persistDecisionSubgraph(
  translated: TranslatedDecision,
  payload: ValidatedPayload,
  source: string,
  userId: number
): Promise<PersistResult> {
  let decisionNodeId = ""
  const committedNodeIds: string[] = []
  const committedEdgeIds: string[] = []

  await executeTransaction(async (tx) => {
    // Validate relatedTo inside transaction to prevent race conditions
    // (nodes could be deleted between a pre-check and edge creation)
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

    // Create nodes
    for (const node of translated.nodes) {
      // Only merge user-provided metadata onto the primary decision node (temp-1)
      // Other nodes (evidence, constraints, etc.) only get internal metadata (source, agentId)
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

    // Create edges
    for (const edge of translated.edges) {
      const sourceId = tempIdToRealId.get(edge.sourceTempId)
      const targetId = tempIdToRealId.get(edge.targetTempId)
      if (!sourceId || !targetId) {
        throw ErrorFactories.validationFailed([{
          field: "edges",
          message: `Edge references unknown tempId: source=${edge.sourceTempId}, target=${edge.targetTempId}`,
        }])
      }

      const [newEdge] = await tx
        .insert(graphEdges)
        .values({
          sourceNodeId: sourceId,
          targetNodeId: targetId,
          edgeType: edge.edgeType.trim(),
          metadata: { source },
          createdBy: userId,
        })
        .returning({ id: graphEdges.id })

      committedEdgeIds.push(newEdge.id)
    }

    // CONTEXT edges for relatedTo (all nodes validated above, batch insert)
    if (payload.relatedTo && payload.relatedTo.length > 0) {
      const contextEdgeValues = payload.relatedTo.map((relatedNodeId) => ({
        sourceNodeId: relatedNodeId,
        targetNodeId: decisionNodeId,
        edgeType: "CONTEXT",
        metadata: { source },
        createdBy: userId,
      }))

      const contextEdges = await tx
        .insert(graphEdges)
        .values(contextEdgeValues)
        .returning({ id: graphEdges.id })

      committedEdgeIds.push(...contextEdges.map((e) => e.id))
    }
  }, "createDecisionSubgraph")

  return { decisionNodeId, committedNodeIds, committedEdgeIds }
}

// ============================================
// POST — Create Decision Subgraph
// ============================================

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "graph:write", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.graph.decisions.create" })

  // 1. Parse JSON body
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return createErrorResponse(requestId, 400, "INVALID_JSON", "Request body must be valid JSON")
  }

  // 2. Validate with Zod
  const parsed = createDecisionSchema.safeParse(body)
  if (!parsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid request body", parsed.error.issues)
  }

  const payload = parsed.data

  // 3. Translate payload to graph nodes + edges
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

  // 4. Persist in transaction (includes relatedTo validation atomically)
  let result: PersistResult
  try {
    result = await persistDecisionSubgraph(translated, payload, source, auth.userId)
  } catch (error) {
    log.error("Failed to create decision subgraph", { error: error instanceof Error ? error.message : String(error) })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to create decision")
  }

  // 5. Compute completeness score (LLM-enhanced with rule-based fallback)
  const completeness = await computeLlmScore(apiPayload, translated.nodes, translated.edges, log)

  log.info("Decision subgraph created", {
    decisionNodeId: result.decisionNodeId,
    nodesCreated: result.committedNodeIds.length,
    edgesCreated: result.committedEdgeIds.length,
    completenessScore: completeness.score,
    completenessMethod: completeness.method,
    userId: auth.userId,
  })

  return createApiResponse(
    {
      data: {
        decisionNodeId: result.decisionNodeId,
        nodesCreated: result.committedNodeIds.length,
        edgesCreated: result.committedEdgeIds.length,
        completenessScore: completeness.score,
        ...(completeness.warnings.length > 0 && { warnings: completeness.warnings }),
      },
      meta: { requestId },
    },
    requestId,
    201
  )
})
