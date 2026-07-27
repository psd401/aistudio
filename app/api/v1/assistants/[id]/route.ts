/**
 * Single Assistant Detail Endpoint
 * GET /api/v1/assistants/:id — Get full assistant details (input fields, prompts)
 * Part of Issue #685 - Assistant Execution API (Phase 2)
 */

import { NextRequest } from "next/server"
import {
  withApiAuth,
  requireScope,
  createApiResponse,
  createErrorResponse,
  extractNumericParam,
  verifyAssistantAccess,
} from "@/lib/api"
import {
  getAssistantById,
  getAssistantForAccessCheck,
} from "@/lib/api/assistant-service"
import { userCanAccessResource } from "@/lib/db/drizzle/resource-access"
import { createLogger } from "@/lib/logger"

// ============================================
// GET — Get Single Assistant
// ============================================

export const GET = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "assistants:list", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.assistants.get" })

  const assistantId = extractNumericParam(request.url, "assistants")
  if (!assistantId) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid assistant ID")
  }

  try {
    const accessError = await verifyAssistantAccess(assistantId, auth, requestId)
    if (accessError) return accessError

    // Apply resource/room visibility only after the base existence + status
    // check. A direct id the caller cannot use is masked as not found rather
    // than disclosing that an unassigned assistant exists.
    const accessRow = await getAssistantForAccessCheck(assistantId)
    const canAccessResource =
      accessRow !== null &&
      await userCanAccessResource(
        auth.userId,
        "assistant",
        assistantId,
        { ownerUserId: accessRow.userId }
      )
    if (!canAccessResource) {
      return createErrorResponse(
        requestId,
        404,
        "NOT_FOUND",
        `Assistant not found: ${assistantId}`
      )
    }

    // Load full details
    const assistant = await getAssistantById(assistantId)
    if (!assistant) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Assistant not found: ${assistantId}`)
    }

    log.info("Retrieved assistant details", { assistantId, userId: auth.userId })

    return createApiResponse(
      {
        data: assistant,
        meta: { requestId },
      },
      requestId
    )
  } catch (error) {
    log.error("Failed to retrieve assistant", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to retrieve assistant")
  }
})
