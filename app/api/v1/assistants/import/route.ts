import { NextRequest } from "next/server"
import {
  createApiResponse,
  createErrorResponse,
  withApiAuth,
} from "@/lib/api"
import { requireActiveRestTool } from "@/lib/api/active-tool-route"
import {
  AssistantImportServiceError,
  createAssistantsFromImport,
} from "@/lib/assistant-architect/import-service"
import {
  ASSISTANT_IMPORT_MAX_BYTES,
} from "@/lib/assistant-export-import"
import {
  BoundedJsonRequestError,
  parseBoundedJsonRequest,
} from "@/lib/api/bounded-json-request"
import { createLogger } from "@/lib/logger"

const CREATE_TOOL_IDENTIFIER = "assistants.create"

export const POST = withApiAuth(
  async (request: NextRequest, auth, requestId) => {
    const catalogError = await requireActiveRestTool(auth, requestId, {
      identifier: CREATE_TOOL_IDENTIFIER,
      fallbackScopes: ["assistants:write"],
      unavailableMessage: "Assistant creation is not available",
    })
    if (catalogError) return catalogError

    let body: unknown
    try {
      body = await parseBoundedJsonRequest(
        request,
        ASSISTANT_IMPORT_MAX_BYTES,
      )
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

    const log = createLogger({
      requestId,
      route: "api.v1.assistants.import",
    })
    try {
      const result = await createAssistantsFromImport(body, auth.userId)
      if (result.successful === 0) {
        log.error("Assistant import created no assistants", {
          userId: auth.userId,
          failed: result.failed,
        })
        return createErrorResponse(
          requestId,
          500,
          "IMPORT_FAILED",
          "Failed to import any assistants",
          result.results,
        )
      }

      log.info("Assistants imported via REST API", {
        userId: auth.userId,
        successful: result.successful,
        failed: result.failed,
      })
      return createApiResponse(
        { data: result, meta: { requestId } },
        requestId,
        201,
      )
    } catch (error) {
      if (error instanceof AssistantImportServiceError) {
        return createErrorResponse(
          requestId,
          error.code === "VALIDATION_ERROR" ? 400 : 500,
          error.code,
          error.message,
        )
      }
      log.error("Failed to import assistants via REST API", {
        error: error instanceof Error ? error.message : String(error),
      })
      return createErrorResponse(
        requestId,
        500,
        "INTERNAL_ERROR",
        "Failed to import assistants",
      )
    }
  },
)
