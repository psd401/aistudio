/**
 * Graph Nodes Collection Endpoint
 * GET  /api/v1/graph/nodes — List nodes with filtering + cursor pagination
 * POST /api/v1/graph/nodes — Create a new node
 * Part of Epic #674 (External API Platform) - Issue #679
 */

import { NextRequest } from "next/server"
import { z } from "zod"
import { withApiAuth, requireScope, createApiResponse, createErrorResponse } from "@/lib/api"
import {
  queryGraphNodes,
  insertGraphNode,
} from "@/lib/graph"
import { createLogger } from "@/lib/logger"

// ============================================
// Validation Schemas
// ============================================

const listQuerySchema = z.object({
  nodeType: z.string().optional(),
  nodeClass: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

const createNodeSchema = z.object({
  name: z.string().min(1).max(500),
  nodeType: z.string().min(1).max(100),
  nodeClass: z.string().min(1).max(100),
  description: z.string().max(5000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

// ============================================
// GET — List Nodes
// ============================================

export const GET = withApiAuth(async (request, auth, requestId) => {
  const scopeError = requireScope(auth, "graph:read", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.graph.nodes.list" })

  const { searchParams } = new URL(request.url)
  const params = Object.fromEntries(searchParams.entries())

  const parsed = listQuerySchema.safeParse(params)
  if (!parsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid query parameters", parsed.error.issues)
  }

  const { limit, cursor, ...filters } = parsed.data

  try {
    const result = await queryGraphNodes(filters, { limit, cursor })

    log.info("Listed graph nodes", { count: result.items.length, userId: auth.userId })

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
    log.error("Failed to list graph nodes", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to retrieve graph nodes")
  }
})

// ============================================
// POST — Create Node
// ============================================

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "graph:write", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.graph.nodes.create" })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return createErrorResponse(requestId, 400, "INVALID_JSON", "Request body must be valid JSON")
  }

  const parsed = createNodeSchema.safeParse(body)
  if (!parsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid request body", parsed.error.issues)
  }

  try {
    const node = await insertGraphNode(parsed.data, auth.userId)

    log.info("Created graph node", { nodeId: node.id, userId: auth.userId })

    return createApiResponse(
      {
        data: node,
        meta: { requestId },
      },
      requestId,
      201
    )
  } catch (error) {
    log.error("Failed to create graph node", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to create graph node")
  }
})
