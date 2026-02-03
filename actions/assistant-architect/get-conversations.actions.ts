"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import type { ActionState } from "@/types"
import { getConversations } from "@/lib/db/drizzle/nexus-conversations"
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle/utils"
import { getAssistantArchitectAction } from "@/actions/db/assistant-architect-actions"

/**
 * Get past conversations for a specific assistant architect
 * with proper authorization checks
 */
export async function getAssistantArchitectConversationsAction(
  toolId: number
): Promise<ActionState<unknown[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAssistantArchitectConversationsAction")
  const log = createLogger({ requestId, action: "getAssistantArchitectConversationsAction" })

  try {
    log.info("Fetching assistant architect conversations", { toolId })

    // Auth check
    const session = await getServerSession()
    if (!session?.sub) {
      log.warn("Unauthorized: no session")
      throw ErrorFactories.authNoSession()
    }

    // Resolve numeric user ID from Cognito sub
    const userId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (!userId) {
      log.warn("User not found for Cognito sub", { sub: session.sub })
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    // Verify user has access to this assistant architect
    const assistantResult = await getAssistantArchitectAction(String(toolId))
    if (!assistantResult.isSuccess || !assistantResult.data) {
      log.warn("Assistant architect not found or unauthorized", { toolId, userId })
      throw ErrorFactories.authzResourceNotFound("assistant-architect", String(toolId))
    }

    // Only approved assistants can be viewed (matches the page.tsx authorization logic)
    if (assistantResult.data.status !== "approved") {
      log.warn("Assistant architect not approved", { toolId, userId, status: assistantResult.data.status })
      throw ErrorFactories.authzInsufficientPermissions("approved", [], { resourceType: "assistant-architect", resourceId: String(toolId) })
    }

    // Fetch conversations filtered by provider
    const conversations = await getConversations(userId, {
      provider: "assistant-architect",
      limit: 50,
      offset: 0,
    })

    // Server-side filter by assistantId in metadata
    const filtered = conversations.filter((conv) => {
      if (!conv.metadata || typeof conv.metadata !== "object") return false
      const metadata = conv.metadata as Record<string, unknown>
      // Handle both number and string types for assistantId (database JSONB flexibility)
      return Number(metadata.assistantId) === toolId
    })

    timer({ status: "success" })
    log.info("Conversations fetched successfully", { toolId, total: conversations.length, filtered: filtered.length })

    return createSuccess(filtered, "Conversations loaded")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load conversations", {
      context: "getAssistantArchitectConversationsAction",
      requestId,
      operation: "getAssistantArchitectConversationsAction",
    })
  }
}
