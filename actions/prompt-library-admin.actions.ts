"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { executeSQL } from "@/lib/db/data-api-adapter"
import { executeTransaction as drizzleTransaction, promptUsageEvents, promptLibrary } from "@/lib/db/drizzle-client"
import { transformSnakeToCamel } from "@/lib/db/field-mapper"
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
import { eq, sql } from "drizzle-orm"

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
    const promptResults = await executeSQL<{
      title: string
      content: string
      user_id: number
    }>(
      `SELECT title, content, user_id
       FROM prompt_library
       WHERE id = :promptId AND deleted_at IS NULL`,
      [{ name: "promptId", value: { stringValue: promptId } }]
    )

    if (promptResults.length === 0) {
      throw ErrorFactories.dbRecordNotFound("prompt_library", promptId)
    }

    const prompt = promptResults[0]

    // Create conversation - this is the critical operation that needs to succeed
    const conversationResults = await executeSQL<{ id: string }>(
      `INSERT INTO nexus_conversations
       (user_id, provider, title, metadata)
       VALUES (:userId, 'openai', :title, :metadata)
       RETURNING id`,
      [
        { name: "userId", value: { longValue: userId } },
        { name: "title", value: { stringValue: `From prompt: ${prompt.title}` } },
        {
          name: "metadata",
          value: {
            stringValue: JSON.stringify({
              fromPromptId: promptId,
              initialPrompt: prompt.content
            })
          }
        }
      ]
    )

    const conversationId = conversationResults[0].id

    // Track usage event and increment counter as Drizzle transaction
    // These are less critical and grouped together for atomicity
    await drizzleTransaction(
      async (tx) => {
        // Insert usage event
        await tx.insert(promptUsageEvents).values({
          promptId,
          userId,
          eventType: 'use',
          conversationId,
        });

        // Increment use count
        await tx
          .update(promptLibrary)
          .set({ useCount: sql`${promptLibrary.useCount} + 1` })
          .where(eq(promptLibrary.id, promptId));

        return true;
      },
      'trackPromptUsage'
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

    // Track view event
    await executeSQL(
      `INSERT INTO prompt_usage_events
       (prompt_id, user_id, event_type)
       VALUES (:promptId, :userId, 'view')`,
      [
        { name: "promptId", value: { stringValue: promptId } },
        { name: "userId", value: { longValue: userId } }
      ]
    )

    // Increment view count
    await executeSQL(
      `UPDATE prompt_library
       SET view_count = view_count + 1
       WHERE id = :promptId`,
      [{ name: "promptId", value: { stringValue: promptId } }]
    )

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

    // Update moderation status
    await executeSQL(
      `UPDATE prompt_library
       SET moderation_status = :status,
           moderated_by = :userId,
           moderated_at = CURRENT_TIMESTAMP,
           moderation_notes = :notes
       WHERE id = :promptId AND deleted_at IS NULL`,
      [
        { name: "status", value: { stringValue: validated.status } },
        { name: "userId", value: { longValue: userId } },
        {
          name: "notes",
          value: validated.notes
            ? { stringValue: validated.notes }
            : { isNull: true }
        },
        { name: "promptId", value: { stringValue: promptId } }
      ]
    )

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

    // Check if user owns the prompt or is admin
    const promptResults = await executeSQL<{ user_id: number }>(
      `SELECT user_id FROM prompt_library WHERE id = :promptId AND deleted_at IS NULL`,
      [{ name: "promptId", value: { stringValue: promptId } }]
    )

    if (promptResults.length === 0) {
      throw ErrorFactories.dbRecordNotFound("prompt_library", promptId)
    }

    const isOwner = promptResults[0].user_id === userId
    const isAdmin = await canModeratePrompts(userId)

    if (!isOwner && !isAdmin) {
      log.warn("Usage stats access denied", { promptId, userId })
      throw ErrorFactories.authzOwnerRequired("view usage statistics")
    }

    // Get counts from prompt table
    const statsResults = await executeSQL<{
      view_count: number
      use_count: number
    }>(
      `SELECT view_count, use_count
       FROM prompt_library
       WHERE id = :promptId`,
      [{ name: "promptId", value: { stringValue: promptId } }]
    )

    const stats = statsResults[0]

    // Get recent events
    const eventResults = await executeSQL<PromptUsageEvent>(
      `SELECT *
       FROM prompt_usage_events
       WHERE prompt_id = :promptId
       ORDER BY created_at DESC
       LIMIT 50`,
      [{ name: "promptId", value: { stringValue: promptId } }]
    )

    const recentEvents = eventResults.map(e =>
      transformSnakeToCamel<PromptUsageEvent>(e)
    )

    timer({ status: "success" })
    log.info("Usage stats retrieved", { promptId })

    return createSuccess({
      totalViews: stats.view_count,
      totalUses: stats.use_count,
      recentEvents
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

    // Get pending prompts
    const results = await executeSQL<{
      id: string
      title: string
      description: string | null
      owner_name: string
      created_at: Date
    }>(
      `SELECT
         p.id,
         p.title,
         p.description,
         u.full_name as owner_name,
         p.created_at
       FROM prompt_library p
       JOIN users u ON p.user_id = u.id
       WHERE p.visibility = 'public'
         AND p.moderation_status = 'pending'
         AND p.deleted_at IS NULL
       ORDER BY p.created_at ASC`,
      []
    )

    const prompts = results.map(r => transformSnakeToCamel<{
      id: string
      title: string
      description: string | null
      ownerName: string
      createdAt: Date
    }>(r))

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
