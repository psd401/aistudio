/**
 * Assistant Conversations Endpoint
 * POST /api/v1/assistants/:id/conversations — Start a new conversation with an assistant
 * Part of Issue #685 - Assistant Execution API (Phase 2)
 *
 * Creates a nexus_conversations record linked to this assistant,
 * executes the assistant with the initial inputs, and returns
 * the conversation ID along with the assistant's response.
 */

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { isValidationError } from "@/types/error-types"
import {
  withApiAuth,
  requireAssistantScope,
  createErrorResponse,
  extractNumericParam,
  verifyAssistantAccess,
  verifyAssistantResourceGrants,
  parseRequestBody,
  isErrorResponse,
  type ApiAuthContext,
} from "@/lib/api"
import { getAssistantById } from "@/lib/api/assistant-service"
import { getAssistantArchitectByIdAction } from "@/actions/db/assistant-architect-actions"
import { INTERNAL_ASSISTANT_LOOKUP } from "@/lib/assistant-architect/internal-access"
import {
  executeAssistant,
  validateExecutionInputs,
  isContentSafetyBlocked,
  isAssistantRuntimeRepositoryInputError,
  prepareAssistantExecutionInputs,
} from "@/lib/api/assistant-execution-service"
import { createConversation } from "@/lib/db/drizzle/nexus-conversations"
import { createMessageWithStats } from "@/lib/db/drizzle/nexus-messages"
import { createLogger } from "@/lib/logger"
import {
  preflightAssistantRepositoryAccess,
  REPOSITORY_ACCESS_CHANGED_MESSAGE,
} from "@/lib/assistant-architect/repository-access-preflight"
import {
  ConversationRepositoryBindingError,
  replaceConversationRepositoryBindings,
} from "@/lib/nexus/conversation-repository-service"
import {
  bindNexusRequestAttachmentReferences,
  NexusAttachmentBindingCleanupError,
  NexusAttachmentBindingRejectedError,
  rollbackNewNexusAttachmentConversation,
} from "@/lib/nexus/request-attachment-binding"
import { compareAssistantPromptExecutionOrder } from "@/lib/assistant-architect/execution-coordinator"
import {
  assertRepositoriesSearchable,
  RepositoryReadinessError,
} from "@/lib/repositories/readiness-service"

export const maxDuration = 900

// ============================================
// Validation
// ============================================

const startConversationSchema = z.object({
  inputs: z.record(z.string(), z.unknown()).default({}),
  title: z.string().max(500).optional(),
})

function isExecutionHttpError(
  error: unknown
): error is { statusCode: 403 | 404; userMessage?: string } {
  return (
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    (error.statusCode === 403 || error.statusCode === 404)
  )
}

type RouteLogger = ReturnType<typeof createLogger>

type StartRequest = {
  inputs: Record<string, unknown>
  title?: string
}

type StartRequestResult =
  | { request: StartRequest; response?: never }
  | { request?: never; response: NextResponse }

type StartAuthorizationResult =
  | { repositoryIds: number[]; response?: never }
  | { repositoryIds?: never; response: NextResponse }

type ConversationRollbackState = {
  conversationId: string | null
  firstMessagePersisted: boolean
}

// eslint-disable-next-line complexity -- Authorization returns precise failures for scope, grants, repository ACLs, and repository readiness.
async function verifyStartAuthorization(
  assistantId: number,
  auth: ApiAuthContext,
  requestId: string,
  log: RouteLogger
): Promise<StartAuthorizationResult> {
  const scopeError = requireAssistantScope(auth, assistantId, requestId)
  if (scopeError) return { response: scopeError }

  const accessError = await verifyAssistantAccess(
    assistantId,
    auth,
    requestId,
    { requireApproved: auth.authType !== "session" }
  )
  if (accessError) return { response: accessError }

  const architectResult = await getAssistantArchitectByIdAction(
    assistantId.toString(),
    INTERNAL_ASSISTANT_LOOKUP
  )
  if (!architectResult.isSuccess || !architectResult.data) {
    return {
      response: createErrorResponse(
        requestId,
        404,
        "NOT_FOUND",
        `Assistant not found: ${assistantId}`
      ),
    }
  }
  const architect = architectResult.data
  const prompts = (architect.prompts || []).sort(
    compareAssistantPromptExecutionOrder
  )
  const lastPromptModelId = prompts.at(-1)?.modelId
  if (!lastPromptModelId) {
    return {
      response: createErrorResponse(
        requestId,
        400,
        "CONFIGURATION_ERROR",
        "Assistant has no model configured"
      ),
    }
  }
  const grantsError = await verifyAssistantResourceGrants({
    auth,
    architectUserId: architect.userId,
    architectId: architect.id,
    modelDbIds:
      (architect.modelRoutingMode ?? "legacy") === "legacy"
        ? prompts
            .map((prompt) => prompt.modelId)
            .filter(
              (modelId): modelId is number =>
                typeof modelId === "number" && modelId > 0
            )
        : [lastPromptModelId],
    assistantId,
    requestId,
    log,
  })
  if (grantsError) return { response: grantsError }

  const repositoryAccess = await preflightAssistantRepositoryAccess(
    prompts,
    auth.cognitoSub
  )
  if (repositoryAccess.isAllowed) {
    return { repositoryIds: repositoryAccess.repositoryIds }
  }
  const inaccessible =
    repositoryAccess.errorCode === "REPOSITORY_BINDING_INACCESSIBLE" ||
    repositoryAccess.errorCode === undefined
  return {
    response: createErrorResponse(
      requestId,
      inaccessible ? 403 : 409,
      repositoryAccess.errorCode ??
        "REPOSITORY_BINDING_INACCESSIBLE",
      inaccessible
        ? REPOSITORY_ACCESS_CHANGED_MESSAGE
        : "A repository used by this assistant is not searchable yet.",
      { repositoryIds: repositoryAccess.repositoryIds }
    ),
  }
}

async function parseStartRequest(
  request: NextRequest,
  requestId: string
): Promise<StartRequestResult> {
  const result = await parseRequestBody(
    request,
    startConversationSchema,
    requestId,
    { maximumBytes: 128 * 1024 }
  )
  if (isErrorResponse(result)) return { response: result }

  const inputErrors = validateExecutionInputs(result.data.inputs)
  if (inputErrors) {
    return {
      response: createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Invalid inputs",
        inputErrors
      ),
    }
  }
  return { request: result.data }
}

function formatInitialUserContent(inputs: Record<string, unknown>): string {
  const entries = Object.entries(inputs)
  if (entries.length === 0) return "(Assistant executed with default inputs)"
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join("\n")
}

function shouldRollbackConversation(
  state: ConversationRollbackState,
  error: unknown
): state is ConversationRollbackState & { conversationId: string } {
  return Boolean(
    state.conversationId &&
      !state.firstMessagePersisted &&
      !(error instanceof NexusAttachmentBindingRejectedError) &&
      !(error instanceof NexusAttachmentBindingCleanupError)
  )
}

async function compensateEmptyConversation(
  state: ConversationRollbackState,
  error: unknown,
  auth: ApiAuthContext,
  requestId: string,
  log: RouteLogger
): Promise<NextResponse | null> {
  if (!shouldRollbackConversation(state, error)) return null
  try {
    await rollbackNewNexusAttachmentConversation({
      ownerId: auth.userId,
      conversationId: state.conversationId,
    })
    return null
  } catch (cleanupError) {
    log.error("Failed to compensate an empty assistant conversation", {
      conversationId: state.conversationId,
      error:
        cleanupError instanceof Error
          ? cleanupError.message
          : "Unknown cleanup error",
    })
    return createErrorResponse(
      requestId,
      500,
      "EXECUTION_ERROR",
      "Failed to start conversation"
    )
  }
}

// eslint-disable-next-line complexity -- Preserve structured errors from each pre-conversation validation and compensation boundary.
function mapStartConversationError(
  error: unknown,
  state: ConversationRollbackState,
  assistantId: number,
  requestId: string,
  log: RouteLogger
): NextResponse {
  if (error instanceof NexusAttachmentBindingRejectedError) {
    return createErrorResponse(
      requestId,
      400,
      "VALIDATION_ERROR",
      "Temporary repository input is unavailable"
    )
  }
  if (error instanceof NexusAttachmentBindingCleanupError) {
    log.error("Failed to remove a rejected empty assistant conversation", {
      conversationId: state.conversationId,
      error: error.message,
    })
    return createErrorResponse(
      requestId,
      500,
      "EXECUTION_ERROR",
      "Failed to start conversation"
    )
  }
  if (error instanceof RepositoryReadinessError) {
    return createErrorResponse(
      requestId,
      error.code === "REPOSITORY_BINDING_INACCESSIBLE" ? 403 : 409,
      error.code,
      error.message,
      { repositories: error.repositories }
    )
  }
  if (error instanceof ConversationRepositoryBindingError) {
    return createErrorResponse(
      requestId,
      error.code === "REPOSITORY_BINDING_INACCESSIBLE" ? 403 : 404,
      error.code,
      error.message,
      { repositoryIds: error.repositoryIds }
    )
  }
  if (isAssistantRuntimeRepositoryInputError(error)) {
    return createErrorResponse(
      requestId,
      400,
      "VALIDATION_ERROR",
      error.message
    )
  }
  if (isContentSafetyBlocked(error)) {
    return createErrorResponse(requestId, 400, "CONTENT_BLOCKED", error.message, {
      categories: error.blockedCategories,
      source: error.source,
    })
  }
  if (isValidationError(error)) {
    return createErrorResponse(
      requestId,
      400,
      "CONFIGURATION_ERROR",
      error.fields?.map(({ message }) => message).join("; ") ||
        "Assistant configuration is invalid"
    )
  }
  if (isExecutionHttpError(error)) {
    const isNotFound = error.statusCode === 404
    return createErrorResponse(
      requestId,
      error.statusCode,
      isNotFound ? "NOT_FOUND" : "FORBIDDEN",
      error.userMessage ||
        (isNotFound
          ? `Assistant not found: ${assistantId}`
          : "You do not have access to repository content used by this assistant")
    )
  }
  log.error("Failed to start conversation", {
    error: error instanceof Error ? error.message : String(error),
    assistantId,
  })
  return createErrorResponse(
    requestId,
    500,
    "EXECUTION_ERROR",
    "Failed to start conversation"
  )
}

// eslint-disable-next-line max-params -- The route boundary keeps authenticated identity, request correlation, logging, and preflighted bindings explicit.
async function startConversation(
  assistantId: number,
  request: StartRequest,
  auth: ApiAuthContext,
  requestId: string,
  log: RouteLogger,
  staticRepositoryIds: number[]
): Promise<NextResponse> {
  const state: ConversationRollbackState = {
    conversationId: null,
    firstMessagePersisted: false,
  }
  try {
    const preparedInputs = await prepareAssistantExecutionInputs(
      request.inputs,
      auth.userId
    )
    await assertRepositoriesSearchable(preparedInputs.runtimeRepositoryIds)
    const repositoryIds = [
      ...new Set([
        ...staticRepositoryIds,
        ...preparedInputs.runtimeRepositoryIds,
      ]),
    ]
    const assistant = await getAssistantById(assistantId)
    if (!assistant) {
      return createErrorResponse(
        requestId,
        404,
        "NOT_FOUND",
        `Assistant not found: ${assistantId}`
      )
    }
    const conversation = await createConversation({
      userId: auth.userId,
      title: request.title || `${assistant.name} Conversation`,
      provider: "assistant-architect",
      metadata: {
        source: "api",
        assistantId,
        assistantName: assistant.name,
        repositoryIds,
        runtimeRepositoryIds: preparedInputs.runtimeRepositoryIds,
      },
    })
    state.conversationId = conversation.id
    await bindNexusRequestAttachmentReferences({
      ownerId: auth.userId,
      conversationId: conversation.id,
      references: preparedInputs.references,
      conversationCreated: true,
    })
    await replaceConversationRepositoryBindings({
      conversationId: conversation.id,
      userId: auth.userId,
      repositoryIds,
      source: "assistant",
      sourceId: String(assistantId),
    })
    log.info("Conversation created", {
      conversationId: conversation.id,
      assistantId,
      userId: auth.userId,
    })

    const userContent = formatInitialUserContent(preparedInputs.inputs)
    await createMessageWithStats({
      conversationId: conversation.id,
      role: "user",
      content: userContent,
      parts: [{ type: "text", text: userContent }],
      metadata: { inputs: preparedInputs.inputs, source: "api" },
    })
    state.firstMessagePersisted = true

    const execution = await executeAssistant({
      assistantId,
      inputs: preparedInputs.inputs,
      userId: auth.userId,
      cognitoSub: auth.cognitoSub,
      requestId,
      preparedInputs,
      requireApproved: auth.authType !== "session",
    })
    return new NextResponse(execution.streamResponse.body, {
      status: execution.streamResponse.status,
      headers: {
        ...Object.fromEntries(execution.streamResponse.headers.entries()),
        "X-Conversation-Id": conversation.id,
        "X-Request-Id": requestId,
      },
    })
  } catch (error) {
    const compensationError = await compensateEmptyConversation(
      state,
      error,
      auth,
      requestId,
      log
    )
    return (
      compensationError ??
      mapStartConversationError(error, state, assistantId, requestId, log)
    )
  }
}

// ============================================
// POST — Start Conversation
// ============================================

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const log = createLogger({ requestId, route: "api.v1.assistants.conversations.start" })
  const assistantId = extractNumericParam(request.url, "assistants")
  if (!assistantId) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid assistant ID")
  }

  const authorization = await verifyStartAuthorization(
    assistantId,
    auth,
    requestId,
    log
  )
  if (authorization.response) return authorization.response

  const parsed = await parseStartRequest(request, requestId)
  if (parsed.response) return parsed.response
  return startConversation(
    assistantId,
    parsed.request,
    auth,
    requestId,
    log,
    authorization.repositoryIds
  )
})
