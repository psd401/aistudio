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
  parseRequestBody,
  isErrorResponse,
} from "@/lib/api"
import { getAssistantById } from "@/lib/api/assistant-service"
import {
  executeAssistant,
  validateExecutionInputs,
  isContentSafetyBlocked,
} from "@/lib/api/assistant-execution-service"
import { createConversation } from "@/lib/db/drizzle/nexus-conversations"
import { createMessageWithStats } from "@/lib/db/drizzle/nexus-messages"
import { createLogger } from "@/lib/logger"

export const maxDuration = 900

// ============================================
// Validation
// ============================================

const startConversationSchema = z.object({
  inputs: z.record(z.string(), z.unknown()).default({}),
  title: z.string().max(500).optional(),
})

// ============================================
// POST — Start Conversation
// ============================================

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const log = createLogger({ requestId, route: "api.v1.assistants.conversations.start" })

  // 1. Extract assistant ID
  const assistantId = extractNumericParam(request.url, "assistants")
  if (!assistantId) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid assistant ID")
  }

  // 2. Check scope
  const scopeError = requireAssistantScope(auth, assistantId, requestId)
  if (scopeError) return scopeError

  // 3. Verify access
  const accessError = await verifyAssistantAccess(assistantId, auth, requestId)
  if (accessError) return accessError

  // 4. Parse body
  const result = await parseRequestBody(request, startConversationSchema, requestId)
  if (isErrorResponse(result)) return result
  const { inputs, title } = result.data

  const inputErrors = validateExecutionInputs(inputs)
  if (inputErrors) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid inputs", inputErrors)
  }

  try {
    // 5. Get assistant details for the conversation title
    const assistant = await getAssistantById(assistantId)
    if (!assistant) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Assistant not found: ${assistantId}`)
    }

    // 6. Create the conversation
    const conversation = await createConversation({
      userId: auth.userId,
      title: title || `${assistant.name} Conversation`,
      provider: "assistant-architect",
      metadata: {
        source: "api",
        assistantId,
        assistantName: assistant.name,
      },
    })

    log.info("Conversation created", {
      conversationId: conversation.id,
      assistantId,
      userId: auth.userId,
    })

    // 7. Save the user message (the inputs as initial context)
    const userContent = Object.entries(inputs).length > 0
      ? Object.entries(inputs)
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join("\n")
      : "(Assistant executed with default inputs)"

    await createMessageWithStats({
      conversationId: conversation.id,
      role: "user",
      content: userContent,
      parts: [{ type: "text", text: userContent }],
      metadata: { inputs, source: "api" },
    })

    // 8. Execute the assistant
    const execResult = await executeAssistant({
      assistantId,
      inputs,
      userId: auth.userId,
      cognitoSub: auth.cognitoSub,
      requestId,
    })

    // Return SSE stream with conversation ID in headers
    return new NextResponse(execResult.streamResponse.body, {
      status: execResult.streamResponse.status,
      headers: {
        ...Object.fromEntries(execResult.streamResponse.headers.entries()),
        "X-Conversation-Id": conversation.id,
        "X-Request-Id": requestId,
      },
    })
  } catch (error) {
    if (isContentSafetyBlocked(error)) {
      return createErrorResponse(requestId, 400, "CONTENT_BLOCKED", error.message, {
        categories: error.blockedCategories,
        source: error.source,
      })
    }

    log.error("Failed to start conversation", {
      error: error instanceof Error ? error.message : String(error),
      assistantId,
    })
    return createErrorResponse(requestId, 500, "EXECUTION_ERROR", "Failed to start conversation")
  }
})
