/**
 * Assistants Collection Endpoint
 * GET /api/v1/assistants — List assistants accessible to the authenticated user
 * Part of Issue #685 - Assistant Execution API (Phase 2)
 */

import { z } from "zod"
import { withApiAuth, requireScope, createApiResponse, createErrorResponse, isAdminByUserId } from "@/lib/api"
import { listAccessibleAssistants } from "@/lib/api/assistant-service"
import { createLogger } from "@/lib/logger"

// ============================================
// Validation Schemas
// ============================================

const listQuerySchema = z.object({
  status: z.enum(["draft", "pending_approval", "approved", "rejected", "disabled"]).optional(),
  search: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

// ============================================
// GET — List Assistants
// ============================================

export const GET = withApiAuth(async (request, auth, requestId) => {
  const scopeError = requireScope(auth, "assistants:list", requestId)
  if (scopeError) return scopeError

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
