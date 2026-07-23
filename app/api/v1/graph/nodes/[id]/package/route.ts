/**
 * Graph Decision-Package Endpoint (Issue #1252)
 * GET /api/v1/graph/nodes/:id/package — Get a self-contained decision package:
 *   the decision plus its evidence / constraints / reasoning / persons /
 *   conditions / outcomes and its supersession chain, gathered by a
 *   depth-bounded, cycle-safe recursive CTE.
 */

import { NextRequest } from "next/server"
import { z } from "zod"
import { withApiAuth, requireScope, createApiResponse, createErrorResponse } from "@/lib/api"
import { getDecisionPackage } from "@/lib/graph/decision-retrieval"
import { createLogger } from "@/lib/logger"

const uuidSchema = z.string().uuid("Invalid node ID format")
const depthSchema = z.coerce.number().int().min(1).max(3).optional()

export const GET = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "graph:read", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.graph.nodes.package" })

  const id = extractIdFromUrl(request.url)
  const idParsed = uuidSchema.safeParse(id)
  if (!idParsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid node ID format")
  }

  const { searchParams } = new URL(request.url)
  const depthParsed = depthSchema.safeParse(searchParams.get("depth") ?? undefined)
  if (!depthParsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "depth must be an integer between 1 and 3")
  }

  try {
    const pkg = await getDecisionPackage(idParsed.data, { maxDepth: depthParsed.data })
    if (!pkg) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Node not found: ${idParsed.data}`)
    }

    log.info("Retrieved decision package", {
      nodeId: idParsed.data,
      nodeCount: pkg.nodes.length,
      edgeCount: pkg.edges.length,
      supersessionLinks: pkg.supersessionChain.length,
      userId: auth.userId,
    })

    return createApiResponse(
      {
        data: pkg,
        meta: { requestId, depth: pkg.depth },
      },
      requestId
    )
  } catch (error) {
    log.error("Failed to retrieve decision package", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to retrieve decision package")
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
