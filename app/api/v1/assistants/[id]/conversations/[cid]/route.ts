/**
 * Conversation History Endpoint
 * GET /api/v1/assistants/:id/conversations/:cid — Get conversation history
 * Part of Issue #685 - Assistant Execution API (Phase 2)
 */

import { NextRequest } from "next/server"
import { z } from "zod"
import {
  withApiAuth,
  requireScope,
  createApiResponse,
  createErrorResponse,
  extractNumericParam,
  extractStringParam,
} from "@/lib/api"
import { getConversationById } from "@/lib/db/drizzle/nexus-conversations"
import { getMessagesByConversation } from "@/lib/db/drizzle/nexus-messages"
import { createLogger } from "@/lib/logger"
import { parseBoundAssistantConversationMetadata } from "@/lib/api/assistant-conversation-metadata"

// ============================================
// Validation
// ============================================

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

// Runtime validation for DB message rows
const messageRowSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string().nullable(),
  parts: z.unknown(),
  createdAt: z.date(),
})

function isBoundAssistantConversation(
  conversation: { provider: string; metadata: unknown },
  assistantId: number
): boolean {
  const metadata = parseBoundAssistantConversationMetadata(
    conversation.metadata
  )
  return (
    conversation.provider === "assistant-architect" &&
    metadata?.assistantId === assistantId
  )
}

function mapConversationMessages(
  messages: unknown[],
  conversationId: string,
  log: ReturnType<typeof createLogger>
) {
  return messages.flatMap((message) => {
    const validated = messageRowSchema.safeParse(message)
    if (!validated.success) {
      log.warn("Invalid message format in conversation", {
        conversationId,
        error: validated.error.message,
      })
      return []
    }
    return [{
      id: validated.data.id,
      role: validated.data.role,
      content: validated.data.content,
      parts: validated.data.parts,
      createdAt: validated.data.createdAt.toISOString(),
    }]
  })
}

function parseHistoryRequest(
  url: string,
  requestId: string
):
  | { value: { assistantId: number; conversationId: string; limit: number; offset: number } }
  | { response: ReturnType<typeof createErrorResponse> } {
  const assistantId = extractNumericParam(url, "assistants")
  const conversationId = extractStringParam(url, "conversations")
  if (!assistantId) {
    return {
      response: createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid assistant ID"),
    }
  }
  if (!conversationId) {
    return {
      response: createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid conversation ID"),
    }
  }
  const params = Object.fromEntries(new URL(url).searchParams.entries())
  const parsed = querySchema.safeParse(params)
  if (!parsed.success) {
    return {
      response: createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Invalid query parameters",
        parsed.error.issues
      ),
    }
  }
  return {
    value: {
      assistantId,
      conversationId,
      limit: parsed.data.limit ?? 50,
      offset: parsed.data.offset ?? 0,
    },
  }
}

// ============================================
// GET — Get Conversation History
// ============================================

export const GET = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "assistants:list", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.assistants.conversations.get" })

  const parsedRequest = parseHistoryRequest(request.url, requestId)
  if ("response" in parsedRequest) return parsedRequest.response
  const { assistantId, conversationId, limit, offset } = parsedRequest.value

  try {
    // Verify conversation exists and belongs to user
    const conversation = await getConversationById(conversationId, auth.userId)
    if (!conversation) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Conversation not found: ${conversationId}`)
    }
    if (!isBoundAssistantConversation(conversation, assistantId)) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Conversation not found: ${conversationId}`)
    }

    // Get messages
    const messages = await getMessagesByConversation(conversationId, {
      limit,
      offset,
    })

    // Validate and map messages to API response shape
    const responseMessages = mapConversationMessages(
      messages as unknown[],
      conversationId,
      log
    )

    log.info("Retrieved conversation history", {
      conversationId,
      messageCount: responseMessages.length,
    })

    return createApiResponse(
      {
        data: {
          conversation: {
            id: conversation.id,
            title: conversation.title,
            provider: conversation.provider,
            messageCount: conversation.messageCount,
            createdAt: conversation.createdAt?.toISOString() ?? null,
            updatedAt: conversation.updatedAt?.toISOString() ?? null,
          },
          messages: responseMessages,
        },
        meta: {
          requestId,
          limit,
          offset,
        },
      },
      requestId
    )
  } catch (error) {
    log.error("Failed to retrieve conversation", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to retrieve conversation")
  }
})
