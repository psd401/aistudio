"use server"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"
import {
  getConversationById,
  archiveConversation,
} from "@/lib/db/drizzle/nexus-conversations"
import type { ActionState } from "@/types"

interface ArchiveConversationParams {
  conversationId: string
}

interface ArchiveConversationResult {
  conversationId: string
  isArchived: boolean
}

/**
 * Archive a Nexus conversation
 *
 * Migrated to Drizzle ORM as part of Epic #526, Issue #533
 */
export async function archiveConversationAction(params: ArchiveConversationParams): Promise<ActionState<ArchiveConversationResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("archiveConversation")
  const log = createLogger({ requestId, action: "archiveConversation" })

  try {
    log.info("Action started", { params: sanitizeForLogging(params) })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
    }

    // Get current user with integer ID
    const currentUser = await getCurrentUserAction()
    if (!currentUser.isSuccess) {
      log.error("Failed to get current user")
      throw ErrorFactories.authNoSession()
    }

    const userId = currentUser.data.user.id
    const { conversationId } = params

    // Verify conversation exists and user owns it using Drizzle
    const existing = await getConversationById(conversationId, userId)

    if (!existing) {
      log.warn("Conversation not found or access denied", { conversationId, userId })
      throw ErrorFactories.dbRecordNotFound("nexus_conversations", conversationId)
    }

    // If already archived, return success
    if (existing.isArchived) {
      log.info("Conversation already archived", { conversationId })
      timer({ status: "success" })
      return createSuccess({ conversationId, isArchived: true }, "Conversation is already archived")
    }

    // Archive the conversation using Drizzle
    const result = await archiveConversation(conversationId, userId)

    if (!result) {
      log.error("Failed to archive conversation - no rows updated")
      throw ErrorFactories.sysInternalError("Failed to archive conversation")
    }

    timer({ status: "success" })
    log.info("Action completed", {
      conversationId,
      isArchived: result.isArchived
    })

    return createSuccess(
      {
        conversationId: result.id,
        isArchived: Boolean(result.isArchived)
      },
      "Conversation archived successfully"
    )

  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to archive conversation", {
      context: "archiveConversation",
      requestId,
      operation: "archiveConversation"
    })
  }
}