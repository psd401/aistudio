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
  extractStringParam,
} from "@/lib/api"
import { getConversationById } from "@/lib/db/drizzle/nexus-conversations"
import { getMessagesByConversation } from "@/lib/db/drizzle/nexus-messages"
import { createLogger } from "@/lib/logger"

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

// ============================================
// GET — Get Conversation History
// ============================================

export const GET = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "assistants:list", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.assistants.conversations.get" })

  const conversationId = extractStringParam(request.url, "conversations")
  if (!conversationId) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid conversation ID")
  }

  // Parse query params
  const { searchParams } = new URL(request.url)
  const params = Object.fromEntries(searchParams.entries())
  const parsed = querySchema.safeParse(params)
  if (!parsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid query parameters", parsed.error.issues)
  }

  try {
    // Verify conversation exists and belongs to user
    const conversation = await getConversationById(conversationId, auth.userId)
    if (!conversation) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Conversation not found: ${conversationId}`)
    }

    // Get messages
    const messages = await getMessagesByConversation(conversationId, {
      limit: parsed.data.limit ?? 50,
      offset: parsed.data.offset ?? 0,
    })

    // Validate and map messages to API response shape
    const responseMessages = (messages as unknown[]).map((msg) => {
      const validated = messageRowSchema.safeParse(msg)
      if (!validated.success) {
        log.warn("Invalid message format in conversation", { conversationId, error: validated.error.message })
        return null
      }
      return {
        id: validated.data.id,
        role: validated.data.role,
        content: validated.data.content,
        parts: validated.data.parts,
        createdAt: validated.data.createdAt.toISOString(),
      }
    }).filter((m): m is NonNullable<typeof m> => m !== null)

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
          limit: parsed.data.limit ?? 50,
          offset: parsed.data.offset ?? 0,
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
