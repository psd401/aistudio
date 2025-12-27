"use server"

import { getServerSession } from "@/lib/auth/server-session"
import {
  incrementViewCount,
  trackUsageEvent,
  moderatePrompt as drizzleModeratePrompt,
  getPromptUsageStats as drizzleGetPromptUsageStats,
  getPendingPrompts as drizzleGetPendingPrompts,
  usePromptAndCreateConversation,
  getPromptById
} from "@/lib/db/drizzle"
import { type ActionState } from "@/types/actions-types"
import {
  handleError,
  ErrorFactories,
  createSuccess
} from "@/lib/error-utils"
import {
  createLogger,
  generateRequestId,
  startTimer
} from "@/lib/logger"
import { revalidatePath } from "next/cache"
import {
  canModeratePrompts,
  canReadPrompt,
  getUserIdFromSession
} from "@/lib/prompt-library/access-control"
import {
  moderatePromptSchema,
  type ModeratePromptInput
} from "@/lib/prompt-library/validation"
import type { PromptUsageEvent } from "@/lib/prompt-library/types"

/**
 * Track prompt usage (creates a conversation from a prompt)
 */
export async function usePrompt(
  promptId: string
): Promise<ActionState<{ conversationId: string }>> {
  const requestId = generateRequestId()
  const timer = startTimer("usePrompt")
  const log = createLogger({ requestId, action: "usePrompt" })

  try {
    log.info("Action started: Using prompt", { promptId })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized prompt use attempt")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Check read access
    const canRead = await canReadPrompt(promptId, userId)
    if (!canRead) {
      log.warn("Prompt use denied - no read access", { promptId, userId })
      throw ErrorFactories.authzResourceNotFound("Prompt", promptId)
    }

    // Get prompt content
    const prompt = await getPromptById(promptId)
    if (!prompt) {
      throw ErrorFactories.dbRecordNotFound("prompt_library", promptId)
    }

    // Use Drizzle function that handles:
    // 1. Create conversation
    // 2. Track usage event
    // 3. Increment use count
    // All in a single transaction
    const conversationId = await usePromptAndCreateConversation(
      promptId,
      userId,
      prompt.title,
      prompt.content
    )

    timer({ status: "success" })
    log.info("Prompt used successfully", { promptId, conversationId })

    return createSuccess(
      { conversationId },
      "New conversation created from prompt"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to use prompt", {
      context: "usePrompt",
      requestId,
      operation: "usePrompt",
      metadata: { promptId }
    })
  }
}

/**
 * Track prompt view
 */
export async function viewPrompt(promptId: string): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("viewPrompt")
  const log = createLogger({ requestId, action: "viewPrompt" })

  try {
    log.info("Action started: Viewing prompt", { promptId })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized prompt view attempt")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Check read access
    const canRead = await canReadPrompt(promptId, userId)
    if (!canRead) {
      log.warn("Prompt view denied - no read access", { promptId, userId })
      throw ErrorFactories.authzResourceNotFound("Prompt", promptId)
    }

    // Track view event and increment count via Drizzle
    await trackUsageEvent(promptId, userId, 'view')
    await incrementViewCount(promptId)

    timer({ status: "success" })
    log.debug("Prompt view tracked", { promptId })

    return createSuccess(undefined)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to track prompt view", {
      context: "viewPrompt",
      requestId,
      operation: "viewPrompt",
      metadata: { promptId }
    })
  }
}

/**
 * Moderate a prompt (admin only)
 */
export async function moderatePrompt(
  promptId: string,
  input: ModeratePromptInput
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("moderatePrompt")
  const log = createLogger({ requestId, action: "moderatePrompt" })

  try {
    log.info("Action started: Moderating prompt", {
      promptId,
      status: input.status
    })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized moderation attempt")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Check moderation permission
    const canModerate = await canModeratePrompts(userId)
    if (!canModerate) {
      log.warn("Moderation denied - not an admin", { userId })
      throw ErrorFactories.authzAdminRequired("moderate prompts")
    }

    // Validate input
    const validated = moderatePromptSchema.parse(input)

    // Update moderation status via Drizzle
    const moderated = await drizzleModeratePrompt(
      promptId,
      validated.status,
      userId,
      validated.notes ?? undefined
    )

    if (!moderated) {
      throw ErrorFactories.dbRecordNotFound("prompt_library", promptId)
    }

    timer({ status: "success" })
    log.info("Prompt moderated successfully", {
      promptId,
      status: validated.status
    })

    revalidatePath("/prompt-library")
    revalidatePath("/admin/prompts")

    return createSuccess(undefined, `Prompt ${validated.status}`)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to moderate prompt", {
      context: "moderatePrompt",
      requestId,
      operation: "moderatePrompt",
      metadata: { promptId }
    })
  }
}

/**
 * Get usage statistics for a prompt
 */
export async function getPromptUsageStats(
  promptId: string
): Promise<
  ActionState<{
    totalViews: number
    totalUses: number
    recentEvents: PromptUsageEvent[]
  }>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getPromptUsageStats")
  const log = createLogger({ requestId, action: "getPromptUsageStats" })

  try {
    log.info("Action started: Getting prompt usage stats", { promptId })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized usage stats access")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Check ownership first (get prompt to verify)
    const prompt = await getPromptById(promptId)
    if (!prompt) {
      throw ErrorFactories.dbRecordNotFound("prompt_library", promptId)
    }

    const isOwner = prompt.userId === userId
    const isAdmin = await canModeratePrompts(userId)

    if (!isOwner && !isAdmin) {
      log.warn("Usage stats access denied", { promptId, userId })
      throw ErrorFactories.authzOwnerRequired("view usage statistics")
    }

    // Get stats via Drizzle
    const stats = await drizzleGetPromptUsageStats(promptId)

    timer({ status: "success" })
    log.info("Usage stats retrieved", { promptId })

    return createSuccess({
      totalViews: stats.totalViews,
      totalUses: stats.totalUses,
      recentEvents: stats.recentEvents.map(e => ({
        id: e.id,
        promptId: e.promptId,
        userId: e.userId,
        eventType: e.eventType as 'view' | 'use' | 'share',
        conversationId: e.conversationId,
        createdAt: e.createdAt?.toISOString() ?? new Date().toISOString()
      }))
    })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to get usage statistics", {
      context: "getPromptUsageStats",
      requestId,
      operation: "getPromptUsageStats",
      metadata: { promptId }
    })
  }
}

/**
 * Get all prompts pending moderation (admin only)
 */
export async function getPendingPrompts(): Promise<
  ActionState<Array<{
    id: string
    title: string
    description: string | null
    ownerName: string
    createdAt: Date
  }>>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getPendingPrompts")
  const log = createLogger({ requestId, action: "getPendingPrompts" })

  try {
    log.info("Action started: Getting pending prompts")

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized pending prompts access")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Check moderation permission
    const canModerate = await canModeratePrompts(userId)
    if (!canModerate) {
      log.warn("Pending prompts access denied - not an admin", { userId })
      throw ErrorFactories.authzAdminRequired("view pending prompts")
    }

    // Get pending prompts via Drizzle
    const prompts = await drizzleGetPendingPrompts()

    timer({ status: "success" })
    log.info("Pending prompts retrieved", { count: prompts.length })

    return createSuccess(prompts)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to get pending prompts", {
      context: "getPendingPrompts",
      requestId,
      operation: "getPendingPrompts"
    })
  }
}
