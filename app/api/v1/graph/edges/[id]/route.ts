/**
 * Graph Edge Single Resource Endpoint
 * DELETE /api/v1/graph/edges/:id — Delete an edge
 * Part of Epic #674 (External API Platform) - Issue #679
 */

import { NextRequest } from "next/server"
import { z } from "zod"
import { withApiAuth, requireScope, createApiResponse, createErrorResponse } from "@/lib/api"
import { removeGraphEdge } from "@/lib/graph"
import { createLogger } from "@/lib/logger"

// ============================================
// Validation
// ============================================

const uuidSchema = z.string().uuid("Invalid edge ID format")

// ============================================
// DELETE — Delete Edge
// ============================================

export const DELETE = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "graph:write", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.graph.edges.delete" })

  const id = extractIdFromUrl(request.url)
  const idParsed = uuidSchema.safeParse(id)
  if (!idParsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid edge ID format")
  }

  try {
    const deleted = await removeGraphEdge(idParsed.data)

    if (!deleted) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Edge not found: ${idParsed.data}`)
    }

    log.info("Deleted graph edge", { edgeId: idParsed.data, userId: auth.userId })

    return createApiResponse(
      {
        data: { deletedId: idParsed.data },
        meta: { requestId },
      },
      requestId
    )
  } catch (error) {
    log.error("Failed to delete graph edge", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to delete graph edge")
  }
})

// ============================================
// URL Helper
// ============================================

function extractIdFromUrl(url: string): string {
  const segments = new URL(url).pathname.split("/")
  const edgesIdx = segments.indexOf("edges")
  return segments[edgesIdx + 1] ?? ""
}
