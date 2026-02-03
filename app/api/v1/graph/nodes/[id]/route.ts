/**
 * Graph Node Single Resource Endpoint
 * GET    /api/v1/graph/nodes/:id — Get a single node
 * PATCH  /api/v1/graph/nodes/:id — Update a node
 * DELETE /api/v1/graph/nodes/:id — Delete a node
 * Part of Epic #674 (External API Platform) - Issue #679
 */

import { NextRequest } from "next/server"
import { z } from "zod"
import { withApiAuth, requireScope, createApiResponse, createErrorResponse } from "@/lib/api"
import {
  queryGraphNode,
  patchGraphNode,
  removeGraphNode,
} from "@/lib/graph"
import { createLogger } from "@/lib/logger"
import { graphMetadataSchema } from "@/lib/validations/api-schemas"

// ============================================
// Validation Schemas
// ============================================

const uuidSchema = z.string().uuid("Invalid node ID format")

const updateNodeSchema = z.object({
  name: z.string().trim().min(1).max(500).optional(),
  nodeType: z.string().trim().min(1).max(100).optional(),
  nodeClass: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(5000).nullable().optional(),
  metadata: graphMetadataSchema.optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: "At least one field must be provided for update" }
)

// ============================================
// GET — Single Node
// ============================================

export const GET = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "graph:read", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.graph.nodes.get" })

  const id = extractIdFromUrl(request.url)
  const idParsed = uuidSchema.safeParse(id)
  if (!idParsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid node ID format")
  }

  try {
    const node = await queryGraphNode(idParsed.data)

    if (!node) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Node not found: ${idParsed.data}`)
    }

    log.info("Retrieved graph node", { nodeId: node.id, userId: auth.userId })

    return createApiResponse(
      {
        data: node,
        meta: { requestId },
      },
      requestId
    )
  } catch (error) {
    log.error("Failed to retrieve graph node", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to retrieve graph node")
  }
})

// ============================================
// PATCH — Update Node
// ============================================

export const PATCH = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "graph:write", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.graph.nodes.patch" })

  const id = extractIdFromUrl(request.url)
  const idParsed = uuidSchema.safeParse(id)
  if (!idParsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid node ID format")
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return createErrorResponse(requestId, 400, "INVALID_JSON", "Request body must be valid JSON")
  }

  const parsed = updateNodeSchema.safeParse(body)
  if (!parsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid request body", parsed.error.issues)
  }

  try {
    const updated = await patchGraphNode(idParsed.data, parsed.data)

    if (!updated) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Node not found: ${idParsed.data}`)
    }

    log.info("Updated graph node", { nodeId: updated.id, userId: auth.userId })

    return createApiResponse(
      {
        data: updated,
        meta: { requestId },
      },
      requestId
    )
  } catch (error) {
    log.error("Failed to update graph node", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to update graph node")
  }
})

// ============================================
// DELETE — Delete Node
// ============================================

export const DELETE = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "graph:write", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.graph.nodes.delete" })

  const id = extractIdFromUrl(request.url)
  const idParsed = uuidSchema.safeParse(id)
  if (!idParsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid node ID format")
  }

  try {
    const deleted = await removeGraphNode(idParsed.data)

    if (!deleted) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Node not found: ${idParsed.data}`)
    }

    log.info("Deleted graph node", { nodeId: idParsed.data, userId: auth.userId })

    return createApiResponse(
      {
        data: { deletedId: idParsed.data },
        meta: { requestId },
      },
      requestId
    )
  } catch (error) {
    log.error("Failed to delete graph node", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to delete graph node")
  }
})

// ============================================
// URL Helper
// ============================================

function extractIdFromUrl(url: string): string {
  // URL pattern: /api/v1/graph/nodes/{id} or /api/v1/graph/nodes/{id}/connections
  const segments = new URL(url).pathname.split("/")
  // Find 'nodes' segment, then next segment is the id
  const nodesIdx = segments.indexOf("nodes")
  return segments[nodesIdx + 1] ?? ""
}
