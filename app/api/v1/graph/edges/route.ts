/**
 * Graph Edges Collection Endpoint
 * GET  /api/v1/graph/edges — List edges with filtering + cursor pagination
 * POST /api/v1/graph/edges — Create a new edge
 * Part of Epic #674 (External API Platform) - Issue #679
 */

import { NextRequest } from "next/server"
import { z } from "zod"
import { withApiAuth, requireScope, createApiResponse, createErrorResponse } from "@/lib/api"
import {
  queryGraphEdges,
  insertGraphEdge,
  GraphServiceError,
} from "@/lib/graph"
import { createLogger } from "@/lib/logger"

// ============================================
// Validation Schemas
// ============================================

const listQuerySchema = z.object({
  edgeType: z.string().optional(),
  sourceNodeId: z.string().uuid().optional(),
  targetNodeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

const createEdgeSchema = z.object({
  sourceNodeId: z.string().uuid("Invalid sourceNodeId format"),
  targetNodeId: z.string().uuid("Invalid targetNodeId format"),
  edgeType: z.string().min(1).max(100),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (data) => data.sourceNodeId !== data.targetNodeId,
  { message: "sourceNodeId and targetNodeId must be different", path: ["targetNodeId"] }
)

// ============================================
// GET — List Edges
// ============================================

export const GET = withApiAuth(async (request, auth, requestId) => {
  const scopeError = requireScope(auth, "graph:read", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.graph.edges.list" })

  const { searchParams } = new URL(request.url)
  const params = Object.fromEntries(searchParams.entries())

  const parsed = listQuerySchema.safeParse(params)
  if (!parsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid query parameters", parsed.error.issues)
  }

  const { limit, cursor, ...filters } = parsed.data

  try {
    const result = await queryGraphEdges(filters, { limit, cursor })

    log.info("Listed graph edges", { count: result.items.length, userId: auth.userId })

    return createApiResponse(
      {
        data: result.items,
        meta: {
          requestId,
          limit: limit ?? 50,
          nextCursor: result.nextCursor,
        },
      },
      requestId
    )
  } catch (error) {
    log.error("Failed to list graph edges", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to retrieve graph edges")
  }
})

// ============================================
// POST — Create Edge
// ============================================

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "graph:write", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.graph.edges.create" })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return createErrorResponse(requestId, 400, "INVALID_JSON", "Request body must be valid JSON")
  }

  const parsed = createEdgeSchema.safeParse(body)
  if (!parsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid request body", parsed.error.issues)
  }

  try {
    const edge = await insertGraphEdge(parsed.data, auth.userId)

    log.info("Created graph edge", { edgeId: edge.id, userId: auth.userId })

    return createApiResponse(
      {
        data: edge,
        meta: { requestId },
      },
      requestId,
      201
    )
  } catch (error) {
    if (error instanceof GraphServiceError) {
      if (error.code === "NODE_NOT_FOUND") {
        return createErrorResponse(requestId, 404, "NOT_FOUND", error.message)
      }
      if (error.code === "DUPLICATE_EDGE") {
        return createErrorResponse(requestId, 409, "CONFLICT", error.message)
      }
    }

    log.error("Failed to create graph edge", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to create graph edge")
  }
})
