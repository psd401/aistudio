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
  bindNexusRequestAttachmentReferences,
  NexusAttachmentBindingCleanupError,
  NexusAttachmentBindingRejectedError,
  rollbackNewNexusAttachmentConversation,
} from "@/lib/nexus/request-attachment-binding"

export const maxDuration = 900

// ============================================
// Validation
// ============================================

const startConversationSchema = z.object({
  inputs: z.record(z.string(), z.unknown()).default({}),
  title: z.string().max(500).optional(),
})

function isForbiddenExecutionError(
  error: unknown
): error is { statusCode: 403; userMessage?: string } {
  return (
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    error.statusCode === 403
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

type ConversationRollbackState = {
  conversationId: string | null
  hasBoundReferences: boolean
  firstMessagePersisted: boolean
}

async function verifyStartAuthorization(
  assistantId: number,
  auth: ApiAuthContext,
  requestId: string,
  log: RouteLogger
): Promise<NextResponse | null> {
  const scopeError = requireAssistantScope(auth, assistantId, requestId)
  if (scopeError) return scopeError

  const accessError = await verifyAssistantAccess(assistantId, auth, requestId)
  if (accessError) return accessError

  const architectResult = await getAssistantArchitectByIdAction(
    assistantId.toString(),
    INTERNAL_ASSISTANT_LOOKUP
  )
  if (!architectResult.isSuccess || !architectResult.data) {
    return createErrorResponse(
      requestId,
      404,
      "NOT_FOUND",
      `Assistant not found: ${assistantId}`
    )
  }
  const architect = architectResult.data
  const prompts = (architect.prompts || []).sort(
    (left, right) => left.position - right.position
  )
  if (!prompts.at(-1)?.modelId) {
    return createErrorResponse(
      requestId,
      400,
      "CONFIGURATION_ERROR",
      "Assistant has no model configured"
    )
  }
  const grantsError = await verifyAssistantResourceGrants({
    auth,
    architectUserId: architect.userId,
    architectId: architect.id,
    modelDbIds: prompts
      .map((prompt) => prompt.modelId)
      .filter((modelId): modelId is number => typeof modelId === "number" && modelId > 0),
    assistantId,
    requestId,
    log,
  })
  if (grantsError) return grantsError

  const repositoryAccess = await preflightAssistantRepositoryAccess(
    prompts,
    auth.cognitoSub
  )
  if (repositoryAccess.isAllowed) return null
  return createErrorResponse(
    requestId,
    403,
    "FORBIDDEN",
    REPOSITORY_ACCESS_CHANGED_MESSAGE
  )
}

async function parseStartRequest(
  request: NextRequest,
  requestId: string
): Promise<StartRequestResult> {
  const result = await parseRequestBody(
    request,
    startConversationSchema,
    requestId
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
      state.hasBoundReferences &&
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
  if (isForbiddenExecutionError(error)) {
    return createErrorResponse(
      requestId,
      403,
      "FORBIDDEN",
      error.userMessage ||
        "You do not have access to repository content used by this assistant"
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

async function startConversation(
  assistantId: number,
  request: StartRequest,
  auth: ApiAuthContext,
  requestId: string,
  log: RouteLogger
): Promise<NextResponse> {
  const state: ConversationRollbackState = {
    conversationId: null,
    hasBoundReferences: false,
    firstMessagePersisted: false,
  }
  try {
    const preparedInputs = await prepareAssistantExecutionInputs(
      request.inputs,
      auth.userId
    )
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
        runtimeRepositoryIds: preparedInputs.runtimeRepositoryIds,
      },
    })
    state.conversationId = conversation.id
    state.hasBoundReferences = preparedInputs.references.length > 0
    await bindNexusRequestAttachmentReferences({
      ownerId: auth.userId,
      conversationId: conversation.id,
      references: preparedInputs.references,
      conversationCreated: true,
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

  const authorizationError = await verifyStartAuthorization(
    assistantId,
    auth,
    requestId,
    log
  )
  if (authorizationError) return authorizationError

  const parsed = await parseStartRequest(request, requestId)
  if (parsed.response) return parsed.response
  return startConversation(assistantId, parsed.request, auth, requestId, log)
})
