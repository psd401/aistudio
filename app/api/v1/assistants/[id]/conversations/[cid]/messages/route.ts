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
  parseRequestBody,
  isErrorResponse,
} from "@/lib/api"
import { getAssistantArchitectByIdAction } from "@/actions/db/assistant-architect-actions"
import { getConversationById } from "@/lib/db/drizzle/nexus-conversations"
import { getMessagesByConversation, createMessageWithStats } from "@/lib/db/drizzle/nexus-messages"
import { getAIModelById } from "@/lib/db/drizzle"
import { unifiedStreamingService } from "@/lib/streaming/unified-streaming-service"
import { createLogger } from "@/lib/logger"
import type { UIMessage } from "ai"
import type { StreamRequest } from "@/lib/streaming/types"

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

// ============================================
// POST — Send Message
// ============================================

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const log = createLogger({ requestId, route: "api.v1.assistants.conversations.messages" })

  // 1. Extract IDs from URL
  const assistantId = extractNumericParam(request.url, "assistants")
  const conversationId = extractStringParam(request.url, "conversations")
  if (!assistantId) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid assistant ID")
  }
  if (!conversationId) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid conversation ID")
  }

  // 2. Check scope
  const scopeError = requireAssistantScope(auth, assistantId, requestId)
  if (scopeError) return scopeError

  // 3. Verify assistant access
  const accessError = await verifyAssistantAccess(assistantId, auth, requestId)
  if (accessError) return accessError

  // 4. Verify conversation exists and belongs to user
  const conversation = await getConversationById(conversationId, auth.userId)
  if (!conversation) {
    return createErrorResponse(requestId, 404, "NOT_FOUND", `Conversation not found: ${conversationId}`)
  }

  // 5. Parse body
  const bodyResult = await parseRequestBody(request, sendMessageSchema, requestId)
  if (isErrorResponse(bodyResult)) return bodyResult
  const { message: userMessageText } = bodyResult.data

  try {
    // 6. Load assistant to get model and system prompt
    const architectResult = await getAssistantArchitectByIdAction(assistantId.toString())
    if (!architectResult.isSuccess || !architectResult.data) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Assistant not found: ${assistantId}`)
    }

    const architect = architectResult.data
    const prompts = (architect.prompts || []).sort((a, b) => a.position - b.position)
    // Use the last prompt's model and system context for follow-up messages
    const lastPrompt = prompts[prompts.length - 1]
    if (!lastPrompt?.modelId) {
      return createErrorResponse(requestId, 400, "CONFIGURATION_ERROR", "Assistant has no model configured")
    }

    const modelData = await getAIModelById(lastPrompt.modelId)
    if (!modelData || !modelData.modelId || !modelData.provider) {
      return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to resolve model")
    }

    // 7. Load conversation history
    const existingMessages = await getMessagesByConversation(conversationId, {
      limit: 100,
      includeModel: false,
    })

    // Convert to UIMessage format with runtime validation
    const historyMessages: UIMessage[] = (existingMessages as unknown[])
      .map((msg) => {
        const validated = messageRowSchema.safeParse(msg)
        if (!validated.success) return null
        return {
          id: validated.data.id,
          role: validated.data.role as UIMessage["role"],
          parts: Array.isArray(validated.data.parts) && (validated.data.parts as unknown[]).length > 0
            ? validated.data.parts as UIMessage["parts"]
            : [{ type: "text" as const, text: validated.data.content || "" }],
        } as UIMessage
      })
      .filter((m): m is UIMessage => m !== null)

    // 8. Save user message to conversation
    await createMessageWithStats({
      conversationId,
      role: "user",
      content: userMessageText,
      parts: [{ type: "text", text: userMessageText }],
      metadata: { source: "api" },
    })

    // 9. Build messages array with new user message
    const newUserMessage: UIMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text: userMessageText }],
    }

    const allMessages = [...historyMessages, newUserMessage]

    log.info("Sending follow-up message", {
      conversationId,
      assistantId,
      historyLength: historyMessages.length,
    })

    // 10. Stream response using assistant's model and system prompt
    return new Promise<NextResponse>((resolve, reject) => {
      const streamRequest: StreamRequest = {
        messages: allMessages,
        modelId: String(modelData.modelId),
        provider: String(modelData.provider),
        userId: auth.userId.toString(),
        sessionId: auth.cognitoSub,
        conversationId,
        source: "assistant_execution" as const,
        systemPrompt: lastPrompt.systemContext || undefined,
        callbacks: {
          onFinish: async ({ text, usage, finishReason }) => {
            try {
              // Save assistant response to conversation
              await createMessageWithStats({
                conversationId,
                role: "assistant",
                content: text || "",
                parts: [{ type: "text", text: text || "" }],
                modelId: lastPrompt.modelId!,
                tokenUsage: usage || {},
                finishReason: finishReason || "stop",
                metadata: { source: "api", assistantId },
              })

              log.info("Follow-up response saved", {
                conversationId,
                assistantId,
                textLength: text?.length || 0,
              })
            } catch (saveError) {
              log.error("Failed to save assistant response", {
                error: saveError,
                conversationId,
              })
            }
          },
          onError: (error) => {
            log.error("Streaming error in follow-up", { error, conversationId })
          },
        },
      }

      ;(async () => {
        try {
          const streamResponse = await unifiedStreamingService.stream(streamRequest)
          const rawResponse = streamResponse.result.toUIMessageStreamResponse({
            headers: {
              "X-Conversation-Id": conversationId,
              "X-Request-Id": requestId,
            },
          })
          resolve(new NextResponse(rawResponse.body, {
            status: rawResponse.status,
            headers: Object.fromEntries(rawResponse.headers.entries()),
          }))
        } catch (error) {
          log.error("Failed to start follow-up stream", { error, conversationId })
          resolve(
            createErrorResponse(requestId, 500, "EXECUTION_ERROR", "Failed to process message")
          )
        }
      })().catch(reject)
    })
  } catch (error) {
    log.error("Failed to send message", {
      error: error instanceof Error ? error.message : String(error),
      assistantId,
      conversationId,
    })
    return createErrorResponse(requestId, 500, "EXECUTION_ERROR", "Failed to send message")
  }
})
