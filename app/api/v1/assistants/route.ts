/**
 * Assistants Collection Endpoint
 * GET /api/v1/assistants — List assistants accessible to the authenticated user
 * Part of Issue #685 - Assistant Execution API (Phase 2)
 */

import { withApiAuth, requireScope, createApiResponse, createErrorResponse, isAdminByUserId } from "@/lib/api"
import { listAccessibleAssistants } from "@/lib/api/assistant-service"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"
import { createLogger } from "@/lib/logger"
import { listQuerySchema } from "./query-schema"

const LIST_TOOL_IDENTIFIER = "assistants.list"

// ============================================
// GET — List Assistants
// ============================================

export const GET = withApiAuth(async (request, auth, requestId) => {
  // Resolve the REST scope from the tool catalog (single source of truth —
  // issue #924 AC #4/#7), matching the execute route. The catalog declares
  // every required scope (all-of semantics); the literal fallback only applies
  // if the tool is absent from the catalog (e.g. a DB outage that also lost the
  // manifest projection).
  const restScopes = await toolCatalogInstance.getRequiredScopes(LIST_TOOL_IDENTIFIER, "rest")
  const scopesToCheck = restScopes?.length ? restScopes : ["assistants:list"]
  for (const scope of scopesToCheck) {
    const scopeError = requireScope(auth, scope, requestId)
    if (scopeError) return scopeError
  }

  const log = createLogger({ requestId, route: "api.v1.assistants.list" })

  const { searchParams } = new URL(request.url)
  const params = Object.fromEntries(searchParams.entries())

  const parsed = listQuerySchema.safeParse(params)
  if (!parsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid query parameters", parsed.error.issues)
  }

  try {
    const isAdmin = await isAdminByUserId(auth.userId)

    const result = await listAccessibleAssistants(auth.userId, isAdmin, {
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
      status: parsed.data.status,
      search: parsed.data.search,
    })

    log.info("Listed assistants", { count: result.items.length, userId: auth.userId })

    return createApiResponse(
      {
        data: result.items,
        meta: {
          requestId,
          limit: parsed.data.limit ?? 50,
          nextCursor: result.nextCursor,
        },
      },
      requestId
    )
  } catch (error) {
    log.error("Failed to list assistants", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to list assistants")
  }
})
