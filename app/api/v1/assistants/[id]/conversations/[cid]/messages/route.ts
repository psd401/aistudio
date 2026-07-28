/**
 * Conversation Messages Endpoint
 * POST /api/v1/assistants/:id/conversations/:cid/messages — Send a follow-up message
 * Part of Issue #685 - Assistant Execution API (Phase 2)
 *
 * Sends a follow-up message in an existing conversation.
 * The assistant's system prompt and previous conversation context are preserved.
 * Uses the model from the assistant's last prompt in the chain.
 */

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import {
  withApiAuth,
  requireAssistantScope,
  createErrorResponse,
  extractNumericParam,
  extractStringParam,
  verifyAssistantAccess,
  verifyAssistantResourceGrants,
  parseRequestBody,
  isErrorResponse,
  type ApiAuthContext,
} from "@/lib/api"
import { getAssistantArchitectByIdAction } from "@/actions/db/assistant-architect-actions"
import { INTERNAL_ASSISTANT_LOOKUP } from "@/lib/assistant-architect/internal-access"
import { getConversationById } from "@/lib/db/drizzle/nexus-conversations"
import { getMessagesByConversation, createMessageWithStats } from "@/lib/db/drizzle/nexus-messages"
import { getAIModelById } from "@/lib/db/drizzle"
import { unifiedStreamingService } from "@/lib/streaming/unified-streaming-service"
import { createLogger } from "@/lib/logger"
import type { UIMessage } from "ai"
import type { StreamRequest, StreamingCallbacks } from "@/lib/streaming/types"
import {
  preflightAssistantRepositoryAccess,
  REPOSITORY_ACCESS_CHANGED_MESSAGE,
} from "@/lib/assistant-architect/repository-access-preflight"
import {
  formatKnowledgeContext,
  retrieveKnowledgeForPrompt,
} from "@/lib/assistant-architect/knowledge-retrieval"
import { createRepositoryTools } from "@/lib/tools/repository-tools"
import { parseBoundAssistantConversationMetadata } from "@/lib/api/assistant-conversation-metadata"
import {
  compareAssistantPromptExecutionOrder,
  createCoordinatedAssistantExecution,
  remainingAssistantExecutionTimeoutMs,
  settleCoordinatedAssistantExecution,
} from "@/lib/assistant-architect/execution-coordinator"

export const maxDuration = 900

// ============================================
// Validation
// ============================================

const sendMessageSchema = z.object({
  message: z.string().min(1).max(100000),
})

// Runtime validation for DB message rows
const messageRowSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string().nullable(),
  parts: z.unknown(),
})

type RouteLogger = ReturnType<typeof createLogger>

type FollowUpIds = {
  assistantId: number
  conversationId: string
}

type FollowUpContext = {
  ids: FollowUpIds
  auth: ApiAuthContext
  requestId: string
  log: RouteLogger
}

type FollowUpIdsResult =
  | { ids: FollowUpIds; response?: never }
  | { ids?: never; response: NextResponse }

type ConversationBindingResult =
  | { runtimeRepositoryIds: number[]; response?: never }
  | { runtimeRepositoryIds?: never; response: NextResponse }

type FollowUpSetup = {
  modelId: string
  provider: string
  promptModelId: number
  systemPrompt?: string
  repositoryIds: number[]
}

type FollowUpSetupResult =
  | { setup: FollowUpSetup; response?: never }
  | { setup?: never; response: NextResponse }

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

function parseFollowUpIds(
  request: NextRequest,
  requestId: string
): FollowUpIdsResult {
  const assistantId = extractNumericParam(request.url, "assistants")
  if (!assistantId) {
    return {
      response: createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Invalid assistant ID"
      ),
    }
  }
  const conversationId = extractStringParam(request.url, "conversations")
  if (!conversationId) {
    return {
      response: createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Invalid conversation ID"
      ),
    }
  }
  return { ids: { assistantId, conversationId } }
}

async function verifyFollowUpAccess(
  ids: FollowUpIds,
  auth: ApiAuthContext,
  requestId: string
): Promise<NextResponse | null> {
  const scopeError = requireAssistantScope(auth, ids.assistantId, requestId)
  if (scopeError) return scopeError
  return verifyAssistantAccess(
    ids.assistantId,
    auth,
    requestId,
    { requireApproved: auth.authType !== "session" }
  )
}

async function loadConversationBinding(
  ids: FollowUpIds,
  auth: ApiAuthContext,
  requestId: string
): Promise<ConversationBindingResult> {
  const conversation = await getConversationById(
    ids.conversationId,
    auth.userId
  )
  const metadata = parseBoundAssistantConversationMetadata(
    conversation?.metadata
  )
  const isMatchingConversation =
    conversation?.provider === "assistant-architect" &&
    metadata?.assistantId === ids.assistantId
  if (isMatchingConversation) {
    return { runtimeRepositoryIds: metadata.runtimeRepositoryIds }
  }
  return {
    response: createErrorResponse(
      requestId,
      404,
      "NOT_FOUND",
      `Conversation not found: ${ids.conversationId}`
    ),
  }
}

async function loadFollowUpSetup(
  ids: FollowUpIds,
  runtimeRepositoryIds: number[],
  auth: ApiAuthContext,
  requestId: string,
  log: RouteLogger
): Promise<FollowUpSetupResult> {
  const architectResult = await getAssistantArchitectByIdAction(
    ids.assistantId.toString(),
    INTERNAL_ASSISTANT_LOOKUP
  )
  if (!architectResult.isSuccess || !architectResult.data) {
    return {
      response: createErrorResponse(
        requestId,
        404,
        "NOT_FOUND",
        `Assistant not found: ${ids.assistantId}`
      ),
    }
  }
  const architect = architectResult.data
  const prompts = (architect.prompts || []).sort(
    compareAssistantPromptExecutionOrder
  )
  const lastPrompt = prompts.at(-1)
  if (!lastPrompt?.modelId) {
    return {
      response: createErrorResponse(
        requestId,
        400,
        "CONFIGURATION_ERROR",
        "Assistant has no model configured"
      ),
    }
  }

  const grantError = await verifyAssistantResourceGrants({
    auth,
    architectUserId: architect.userId,
    architectId: architect.id,
    modelDbIds: [lastPrompt.modelId],
    assistantId: ids.assistantId,
    requestId,
    log,
  })
  if (grantError) return { response: grantError }

  const repositoryAccess = await preflightAssistantRepositoryAccess(
    [...prompts, { repositoryIds: runtimeRepositoryIds }],
    auth.cognitoSub
  )
  if (!repositoryAccess.isAllowed) {
    return {
      response: createErrorResponse(
        requestId,
        403,
        "FORBIDDEN",
        REPOSITORY_ACCESS_CHANGED_MESSAGE
      ),
    }
  }

  const model = await getAIModelById(lastPrompt.modelId)
  if (!model?.modelId || !model.provider) {
    return {
      response: createErrorResponse(
        requestId,
        500,
        "INTERNAL_ERROR",
        "Failed to resolve model"
      ),
    }
  }
  return {
    setup: {
      modelId: model.modelId,
      provider: model.provider,
      promptModelId: lastPrompt.modelId,
      systemPrompt: lastPrompt.systemContext || undefined,
      repositoryIds: repositoryAccess.repositoryIds,
    },
  }
}

function toHistoryMessages(existingMessages: unknown[]): UIMessage[] {
  return existingMessages
    .map((message) => {
      const validated = messageRowSchema.safeParse(message)
      if (!validated.success) return null
      const parts =
        Array.isArray(validated.data.parts) && validated.data.parts.length > 0
          ? (validated.data.parts as UIMessage["parts"])
          : [{ type: "text" as const, text: validated.data.content || "" }]
      return {
        id: validated.data.id,
        role: validated.data.role as UIMessage["role"],
        parts,
      } satisfies UIMessage
    })
    .filter((message): message is UIMessage => message !== null)
}

async function buildFollowUpMessages(
  ids: FollowUpIds,
  userMessage: string,
  setup: FollowUpSetup,
  auth: ApiAuthContext,
  requestId: string
): Promise<{ messages: UIMessage[]; tools: StreamRequest["tools"] }> {
  const existingMessages = await getMessagesByConversation(ids.conversationId, {
    limit: 100,
    includeModel: false,
  })
  const knowledgeChunks = await retrieveKnowledgeForPrompt(
    userMessage,
    setup.repositoryIds,
    auth.cognitoSub,
    {
      maxChunks: 10,
      maxTokens: 4000,
      similarityThreshold: 0.7,
      searchType: "hybrid",
      vectorWeight: 0.8,
    },
    requestId
  )
  const repositoryContext =
    knowledgeChunks.length > 0
      ? `\n\n${formatKnowledgeContext(knowledgeChunks)}`
      : ""
  const tools =
    setup.repositoryIds.length > 0
      ? (createRepositoryTools({
          repositoryIds: setup.repositoryIds,
          userCognitoSub: auth.cognitoSub,
        }) as NonNullable<StreamRequest["tools"]>)
      : undefined
  return {
    messages: [
      ...toHistoryMessages(existingMessages as unknown[]),
      {
        id: `user-${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text: userMessage + repositoryContext }],
      },
    ],
    tools,
  }
}

async function saveAssistantFollowUp(
  context: FollowUpContext,
  result: {
    promptModelId: number
    text: string
    usage: Parameters<NonNullable<StreamingCallbacks["onFinish"]>>[0]["usage"]
    finishReason: string
  }
): Promise<void> {
  try {
    await createMessageWithStats({
      conversationId: context.ids.conversationId,
      role: "assistant",
      content: result.text || "",
      parts: [{ type: "text", text: result.text || "" }],
      modelId: result.promptModelId,
      tokenUsage: result.usage || {},
      finishReason: result.finishReason || "stop",
      metadata: { source: "api", assistantId: context.ids.assistantId },
    })
    context.log.info("Follow-up response saved", {
      conversationId: context.ids.conversationId,
      assistantId: context.ids.assistantId,
      textLength: result.text?.length || 0,
    })
  } catch (saveError) {
    context.log.error("Failed to save assistant response", {
      error: saveError,
      conversationId: context.ids.conversationId,
    })
  }
}

function createFollowUpCallbacks(
  context: FollowUpContext,
  promptModelId: number,
  executionId: number,
): StreamingCallbacks {
  return {
    onFinish: async ({ text, usage, finishReason }) => {
      await saveAssistantFollowUp(context, {
        promptModelId,
        text,
        usage,
        finishReason,
      })
      await settleCoordinatedAssistantExecution({
        executionId,
        status: "completed",
      })
    },
    onError: (error) => {
      context.log.error("Streaming error in follow-up", {
        error,
        conversationId: context.ids.conversationId,
      })
      void settleCoordinatedAssistantExecution({
        executionId,
        status: "failed",
        errorMessage: error.message,
      }).catch((settlementError) => {
        context.log.error("Failed to settle follow-up execution", {
          executionId,
          error:
            settlementError instanceof Error
              ? settlementError.message
              : String(settlementError),
        })
      })
    },
  }
}

async function streamFollowUp(
  context: FollowUpContext,
  input: {
    setup: FollowUpSetup
    messages: UIMessage[]
    tools: StreamRequest["tools"]
    executionId: number
    deadlineAt: Date
  }
): Promise<NextResponse> {
  const streamRequest: StreamRequest = {
    messages: input.messages,
    modelId: input.setup.modelId,
    provider: input.setup.provider,
    userId: context.auth.userId.toString(),
    sessionId: context.auth.cognitoSub,
    conversationId: context.ids.conversationId,
    source: "assistant_execution",
    executionId: input.executionId,
    systemPrompt: input.setup.systemPrompt,
    tools: input.tools,
    maxSteps: 5,
    timeout: remainingAssistantExecutionTimeoutMs(input.deadlineAt),
    callbacks: createFollowUpCallbacks(
      context,
      input.setup.promptModelId,
      input.executionId
    ),
  }
  try {
    const streamResponse = await unifiedStreamingService.stream(streamRequest)
    const response = streamResponse.result.toUIMessageStreamResponse({
      headers: {
        "X-Conversation-Id": context.ids.conversationId,
        "X-Request-Id": context.requestId,
      },
    })
    return new NextResponse(response.body, {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    })
  } catch (error) {
    await settleCoordinatedAssistantExecution({
      executionId: input.executionId,
      status: "failed",
      errorMessage:
        error instanceof Error ? error.message : "Failed to start stream",
    }).catch((settlementError) => {
      context.log.error("Failed to settle follow-up execution", {
        executionId: input.executionId,
        error:
          settlementError instanceof Error
            ? settlementError.message
            : String(settlementError),
      })
    })
    context.log.error("Failed to start follow-up stream", {
      error,
      conversationId: context.ids.conversationId,
    })
    return createErrorResponse(
      context.requestId,
      500,
      "EXECUTION_ERROR",
      "Failed to process message"
    )
  }
}

async function sendFollowUp(
  context: FollowUpContext,
  request: NextRequest,
  runtimeRepositoryIds: number[]
): Promise<NextResponse> {
  const bodyResult = await parseRequestBody(
    request,
    sendMessageSchema,
    context.requestId,
    { maximumBytes: 128 * 1024 }
  )
  if (isErrorResponse(bodyResult)) return bodyResult
  const userMessage = bodyResult.data.message
  const coordinated = await createCoordinatedAssistantExecution({
    assistantId: context.ids.assistantId,
    userId: context.auth.userId,
    inputs: { message: userMessage },
    requireApproved: context.auth.authType !== "session",
    modelAccessMode: "final_prompt",
  })
  if (!coordinated.created) {
    if (coordinated.reason === "rate_limited") {
      return createErrorResponse(
        context.requestId,
        429,
        "RATE_LIMITED",
        "Assistant execution rate limit exceeded"
      )
    }
    return createErrorResponse(
      context.requestId,
      400,
      "CONFIGURATION_ERROR",
      `Assistant prompt count must be between 1 and ${coordinated.maxPromptCount}`
    )
  }
  const executionId = coordinated.executionId
  try {
    const setupResult = await loadFollowUpSetup(
      context.ids,
      runtimeRepositoryIds,
      context.auth,
      context.requestId,
      context.log
    )
    if (setupResult.response) {
      await settleCoordinatedAssistantExecution({
        executionId,
        status: "failed",
        errorMessage: "Assistant follow-up setup rejected",
      })
      return setupResult.response
    }

    const messageContext = await buildFollowUpMessages(
      context.ids,
      userMessage,
      setupResult.setup,
      context.auth,
      context.requestId
    )
    await createMessageWithStats({
      conversationId: context.ids.conversationId,
      role: "user",
      content: userMessage,
      parts: [{ type: "text", text: userMessage }],
      metadata: { source: "api" },
    })
    context.log.info("Sending follow-up message", {
      conversationId: context.ids.conversationId,
      assistantId: context.ids.assistantId,
      historyLength: messageContext.messages.length - 1,
    })
    return streamFollowUp(context, {
      setup: setupResult.setup,
      messages: messageContext.messages,
      tools: messageContext.tools,
      executionId,
      deadlineAt: coordinated.deadlineAt,
    })
  } catch (error) {
    await settleCoordinatedAssistantExecution({
      executionId,
      status: "failed",
      errorMessage:
        error instanceof Error ? error.message : "Follow-up execution failed",
    }).catch((settlementError) => {
      context.log.error("Failed to settle follow-up execution", {
        executionId,
        error:
          settlementError instanceof Error
            ? settlementError.message
            : String(settlementError),
      })
    })
    throw error
  }
}

// ============================================
// POST — Send Message
// ============================================

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const log = createLogger({ requestId, route: "api.v1.assistants.conversations.messages" })
  const parsedIds = parseFollowUpIds(request, requestId)
  if (parsedIds.response) return parsedIds.response
  const accessError = await verifyFollowUpAccess(
    parsedIds.ids,
    auth,
    requestId
  )
  if (accessError) return accessError
  const binding = await loadConversationBinding(
    parsedIds.ids,
    auth,
    requestId
  )
  if (binding.response) return binding.response
  try {
    return await sendFollowUp(
      { ids: parsedIds.ids, auth, requestId, log },
      request,
      binding.runtimeRepositoryIds
    )
  } catch (error) {
    if (isExecutionHttpError(error)) {
      const isNotFound = error.statusCode === 404
      return createErrorResponse(
        requestId,
        error.statusCode,
        isNotFound ? "NOT_FOUND" : "FORBIDDEN",
        error.userMessage ||
          (isNotFound
            ? `Assistant not found: ${parsedIds.ids.assistantId}`
            : "You do not have access to this assistant")
      )
    }
    log.error("Failed to send message", {
      error: error instanceof Error ? error.message : String(error),
      assistantId: parsedIds.ids.assistantId,
      conversationId: parsedIds.ids.conversationId,
    })
    return createErrorResponse(requestId, 500, "EXECUTION_ERROR", "Failed to send message")
  }
})
