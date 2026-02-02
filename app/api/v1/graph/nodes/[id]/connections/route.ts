/**
 * Graph Node Connections Endpoint
 * GET /api/v1/graph/nodes/:id/connections — Get all connections for a node
 * Part of Epic #674 (External API Platform) - Issue #679
 */

import { NextRequest } from "next/server"
import { z } from "zod"
import { withApiAuth, requireScope, createApiResponse, createErrorResponse } from "@/lib/api"
import { queryGraphNode, queryNodeConnections } from "@/lib/graph"
import { createLogger } from "@/lib/logger"

// ============================================
// Validation
// ============================================

const uuidSchema = z.string().uuid("Invalid node ID format")

// ============================================
// GET — Node Connections
// ============================================

export const GET = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "graph:read", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.graph.nodes.connections" })

  const id = extractIdFromUrl(request.url)
  const idParsed = uuidSchema.safeParse(id)
  if (!idParsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid node ID format")
  }

  try {
    // Verify node exists
    const node = await queryGraphNode(idParsed.data)
    if (!node) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Node not found: ${idParsed.data}`)
    }

    const connections = await queryNodeConnections(idParsed.data)

    log.info("Retrieved node connections", {
      nodeId: idParsed.data,
      connectionCount: connections.length,
      userId: auth.userId,
    })

    return createApiResponse(
      {
        data: connections,
        meta: {
          requestId,
          total: connections.length,
        },
      },
      requestId
    )
  } catch (error) {
    log.error("Failed to retrieve node connections", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to retrieve node connections")
  }
})

// ============================================
// URL Helper
// ============================================

function extractIdFromUrl(url: string): string {
  const segments = new URL(url).pathname.split("/")
  const nodesIdx = segments.indexOf("nodes")
  return segments[nodesIdx + 1] ?? ""
}
