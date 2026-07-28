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
import {
  AssistantImportServiceError,
  updateAssistantFromImport,
} from "@/lib/assistant-architect/import-service"
import {
  ASSISTANT_IMPORT_MAX_BYTES,
} from "@/lib/assistant-export-import"
import {
  BoundedJsonRequestError,
  parseBoundedJsonRequest,
} from "@/lib/api/bounded-json-request"
import { userCanAccessResource } from "@/lib/db/drizzle/resource-access"
import { createLogger } from "@/lib/logger"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"

const UPDATE_TOOL_IDENTIFIER = "assistants.update"

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

// ============================================
// PUT — Replace an Assistant from ExportFormat
// ============================================

export const PUT = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const restScopes = await toolCatalogInstance.getRequiredScopes(
    UPDATE_TOOL_IDENTIFIER,
    "rest",
  )
  const scopesToCheck = restScopes?.length
    ? restScopes
    : ["assistants:write"]
  for (const scope of scopesToCheck) {
    const scopeError = requireScope(auth, scope, requestId)
    if (scopeError) return scopeError
  }

  const assistantId = extractNumericParam(request.url, "assistants")
  if (!assistantId) {
    return createErrorResponse(
      requestId,
      400,
      "VALIDATION_ERROR",
      "Invalid assistant ID",
    )
  }

  let body: unknown
  try {
    body = await parseBoundedJsonRequest(request, ASSISTANT_IMPORT_MAX_BYTES)
  } catch (error) {
    if (
      error instanceof BoundedJsonRequestError &&
      error.status === 413
    ) {
      return createErrorResponse(
        requestId,
        413,
        "PAYLOAD_TOO_LARGE",
        "Import payload too large (maximum 10 MB)",
      )
    }
    return createErrorResponse(
      requestId,
      400,
      "INVALID_JSON",
      "Request body must be valid JSON",
    )
  }

  const log = createLogger({ requestId, route: "api.v1.assistants.update" })
  try {
    const result = await updateAssistantFromImport(
      assistantId,
      body,
      auth.userId,
    )
    log.info("Assistant updated via REST API", {
      assistantId,
      userId: auth.userId,
    })
    return createApiResponse(
      { data: result, meta: { requestId } },
      requestId,
    )
  } catch (error) {
    if (error instanceof AssistantImportServiceError) {
      const status =
        error.code === "VALIDATION_ERROR"
          ? 400
          : error.code === "CONFLICT"
            ? 409
          : error.code === "FORBIDDEN"
            ? 403
            : 404
      return createErrorResponse(
        requestId,
        status,
        error.code,
        error.message,
      )
    }
    log.error("Failed to update assistant via REST API", {
      assistantId,
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(
      requestId,
      500,
      "INTERNAL_ERROR",
      "Failed to update assistant",
    )
  }
})
