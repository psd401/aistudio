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
import { semanticSearchNodes } from "@/lib/graph/decision-retrieval"
import { createLogger } from "@/lib/logger"
import { graphMetadataSchema } from "@/lib/validations/api-schemas"

// ============================================
// Validation Schemas
// ============================================

const listQuerySchema = z.object({
  nodeType: z.string().max(100).optional(),
  nodeClass: z.string().max(100).optional(),
  // Decision lifecycle status filter (Issue #1252). With `nodeType=decision`,
  // `status=accepted` returns only current (non-superseded) decisions.
  status: z.enum(["proposed", "accepted", "superseded", "rejected"]).optional(),
  search: z.string().min(1).max(100).optional(),
  // Semantic (embedding-based) search term (Issue #1252). When present, returns
  // paraphrase matches ranked by similarity instead of literal ILIKE hits.
  q: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

const createNodeSchema = z.object({
  name: z.string().trim().min(1).max(500),
  nodeType: z.string().trim().min(1).max(100),
  nodeClass: z.string().trim().min(1).max(100),
  description: z.string().max(5000).nullable().optional(),
  metadata: graphMetadataSchema.optional(),
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

  const { limit, cursor, q, ...filters } = parsed.data

  try {
    // Semantic search (Issue #1252): `q` returns embedding-based paraphrase
    // matches. On embedding failure it degrades to lexical ILIKE search so the
    // caller always gets results rather than a 500.
    if (q) {
      try {
        const matches = await semanticSearchNodes(q, {
          limit: limit ?? 50,
          nodeType: filters.nodeType,
        })
        log.info("Semantic graph node search", { count: matches.length, userId: auth.userId })
        return createApiResponse(
          {
            data: matches,
            meta: { requestId, limit: limit ?? 50, method: "semantic", nextCursor: null },
          },
          requestId
        )
      } catch (semanticError) {
        log.warn("Semantic search failed, falling back to lexical", {
          error: semanticError instanceof Error ? semanticError.message : String(semanticError),
        })
        const fallback = await queryGraphNodes({ ...filters, search: q }, { limit, cursor })
        return createApiResponse(
          {
            data: fallback.items,
            meta: { requestId, limit: limit ?? 50, method: "lexical-fallback", nextCursor: fallback.nextCursor },
          },
          requestId
        )
      }
    }

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
