import { NextRequest } from "next/server";
import {
  createApiResponse,
  createErrorResponse,
  extractNumericParam,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import {
  AssistantImportServiceError,
  forkAssistant,
} from "@/lib/assistant-architect/import-service";
import {
  BoundedJsonRequestError,
  parseBoundedJsonRequest,
} from "@/lib/api/bounded-json-request";
import { createLogger } from "@/lib/logger";
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog";

const FORK_TOOL_IDENTIFIER = "assistants.fork";
const MAX_ASSISTANT_NAME_LENGTH = 255;
const ASSISTANT_FORK_MAX_BYTES = 4 * 1024;

async function parseForkName(
  request: NextRequest,
  requestId: string,
): Promise<
  | { name: string | undefined }
  | { response: ReturnType<typeof createErrorResponse> }
> {
  let body: unknown;
  try {
    body = await parseBoundedJsonRequest(
      request,
      ASSISTANT_FORK_MAX_BYTES,
      { emptyBodyValue: {} },
    );
  } catch (error) {
    if (
      error instanceof BoundedJsonRequestError &&
      error.status === 413
    ) {
      return {
        response: createErrorResponse(
          requestId,
          413,
          "PAYLOAD_TOO_LARGE",
          "Fork payload too large (maximum 4 KB)",
        ),
      };
    }
    return {
      response: createErrorResponse(
        requestId,
        400,
        "INVALID_JSON",
        "Request body must be valid JSON",
      ),
    };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      response: createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Request body must be an object",
      ),
    };
  }
  const name = (body as Record<string, unknown>).name;
  if (
    name !== undefined &&
    (typeof name !== "string" ||
      name.length === 0 ||
      name.length > MAX_ASSISTANT_NAME_LENGTH)
  ) {
    return {
      response: createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        `name must be a non-empty string up to ${MAX_ASSISTANT_NAME_LENGTH} characters`,
      ),
    };
  }
  return { name: typeof name === "string" ? name : undefined };
}

export const POST = withApiAuth(
  async (request: NextRequest, auth, requestId) => {
    const restScopes = await toolCatalogInstance.getRequiredScopes(
      FORK_TOOL_IDENTIFIER,
      "rest",
    );
    const scopesToCheck = restScopes?.length
      ? restScopes
      : ["assistants:write"];
    for (const scope of scopesToCheck) {
      const scopeError = requireScope(auth, scope, requestId);
      if (scopeError) return scopeError;
    }

    const assistantId = extractNumericParam(request.url, "assistants");
    if (!assistantId) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Invalid assistant ID",
      );
    }

    const parsedBody = await parseForkName(request, requestId);
    if ("response" in parsedBody) return parsedBody.response;

    const log = createLogger({ requestId, route: "api.v1.assistants.fork" });
    try {
      const result = await forkAssistant(
        assistantId,
        auth.userId,
        parsedBody.name,
      );
      log.info("Assistant forked via REST API", {
        sourceAssistantId: assistantId,
        forkAssistantId: result.result.id,
        userId: auth.userId,
      });
      return createApiResponse(
        {
          data: {
            ...result,
            sourceAssistantId: assistantId,
          },
          meta: { requestId },
        },
        requestId,
        201,
      );
    } catch (error) {
      if (error instanceof AssistantImportServiceError) {
        return createErrorResponse(
          requestId,
          error.code === "VALIDATION_ERROR" ? 400 : 404,
          error.code,
          error.message,
        );
      }
      log.error("Failed to fork assistant via REST API", {
        sourceAssistantId: assistantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return createErrorResponse(
        requestId,
        500,
        "INTERNAL_ERROR",
        "Failed to fork assistant",
      );
    }
  },
);
