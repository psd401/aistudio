/**
 * Graph Decisions Collection Endpoint
 * POST /api/v1/graph/decisions — Create a structured decision subgraph
 * Part of Epic #674 (External API Platform) - Issue #683
 *
 * Delegates to shared decision-capture-service (Issue #708).
 */

import { NextRequest } from "next/server"
import { withApiAuth, requireScope, createApiResponse, createErrorResponse, parseRequestBody, isErrorResponse } from "@/lib/api"
import {
  captureStructuredDecision,
  createDecisionSchema,
} from "@/lib/graph/decision-capture-service"
import { isValidationError } from "@/types/error-types"
import { createLogger } from "@/lib/logger"

// ============================================
// POST — Create Decision Subgraph
// ============================================

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "graph:write", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.graph.decisions.create" })

  // 1. Parse and validate request body
  const parsed = await parseRequestBody(request, createDecisionSchema, requestId)
  if (isErrorResponse(parsed)) return parsed

  // 2. Delegate to shared service
  try {
    const result = await captureStructuredDecision(parsed.data, auth.userId, requestId)

    log.info("Decision subgraph created via REST API", {
      decisionNodeId: result.decisionNodeId,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      completenessScore: result.completenessScore,
      completenessMethod: result.completenessMethod,
      userId: auth.userId,
    })

    return createApiResponse(
      {
        data: {
          decisionNodeId: result.decisionNodeId,
          nodesCreated: result.nodesCreated,
          edgesCreated: result.edgesCreated,
          completenessScore: result.completenessScore,
          ...(result.warnings.length > 0 && { warnings: result.warnings }),
        },
        meta: { requestId },
      },
      requestId,
      201
    )
  } catch (error) {
    if (isValidationError(error)) {
      log.warn("Decision subgraph validation failed", { error: error.message })
      return createErrorResponse(requestId, 400, "VALIDATION_ERROR", error.message)
    }
    log.error("Failed to create decision subgraph", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to create decision")
  }
})
