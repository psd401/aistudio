"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { executeSQL } from "@/lib/db/data-api-adapter"
import { transformSnakeToCamel } from "@/lib/db/field-mapper"
import { SqlParameter } from "@aws-sdk/client-rds-data"
import {
  createPrompt as drizzleCreatePrompt,
  setPromptTags,
  getTagsForPrompt,
  getPromptById,
  incrementViewCount,
  incrementUseCount,
  listPrompts as drizzleListPrompts,
  updatePrompt as drizzleUpdatePrompt,
  deletePrompt as drizzleDeletePrompt,
  trackUsageEvent
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
  startTimer,
  sanitizeForLogging
} from "@/lib/logger"
import { revalidatePath } from "next/cache"
import {
  canAccessPromptLibrary,
  canReadPrompt,
  canUpdatePrompt,
  canDeletePrompt,
  getUserIdFromSession
} from "@/lib/prompt-library/access-control"
import {
  createPromptSchema,
  updatePromptSchema,
  promptSearchSchema,
  type CreatePromptInput,
  type UpdatePromptInput,
  type PromptSearchInput
} from "@/lib/prompt-library/validation"
import type {
  Prompt,
  PromptListItem,
  PromptListResult
} from "@/lib/prompt-library/types"

/**
 * Create a new prompt
 */
export async function createPrompt(
  input: CreatePromptInput
): Promise<ActionState<Prompt>> {
  const requestId = generateRequestId()
  const timer = startTimer("createPrompt")
  const log = createLogger({ requestId, action: "createPrompt" })

  try {
    log.info("Action started: Creating prompt", {
      title: sanitizeForLogging(input.title)
    })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized prompt creation attempt")
      throw ErrorFactories.authNoSession()
    }

    // Get user ID
    const userId = await getUserIdFromSession(session.sub)
    log.debug("User ID retrieved", { userId })

    // Check access
    const hasAccess = await canAccessPromptLibrary(userId)
    if (!hasAccess) {
      log.warn("Prompt creation denied - insufficient permissions", {
        userId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Validate input
    const validated = createPromptSchema.parse(input)

    log.info("Creating prompt in database", {
      visibility: validated.visibility,
      tagCount: validated.tags?.length || 0
    })

    // Create prompt via Drizzle (moderation_status handled automatically)
    const result = await drizzleCreatePrompt({
      userId,
      title: validated.title,
      content: validated.content,
      description: validated.description,
      visibility: validated.visibility,
      sourceMessageId: validated.sourceMessageId,
      sourceConversationId: validated.sourceConversationId
    })

    // Build prompt object with type conversion
    // Note: result has incomplete type annotation but .returning() gives all fields
    const resultWithAllFields = result as typeof result & {
      moderatedBy: number | null
      moderatedAt: Date | null
      moderationNotes: string | null
      sourceMessageId: string | null
      sourceConversationId: string | null
      deletedAt: Date | null
    }

    const prompt: Prompt = {
      id: resultWithAllFields.id,
      userId: resultWithAllFields.userId,
      title: resultWithAllFields.title,
      content: resultWithAllFields.content,
      description: resultWithAllFields.description,
      visibility: resultWithAllFields.visibility as 'public' | 'private',
      moderationStatus: resultWithAllFields.moderationStatus as 'pending' | 'approved' | 'rejected',
      moderatedBy: resultWithAllFields.moderatedBy,
      moderatedAt: resultWithAllFields.moderatedAt?.toISOString() ?? null,
      moderationNotes: resultWithAllFields.moderationNotes,
      sourceMessageId: resultWithAllFields.sourceMessageId,
      sourceConversationId: resultWithAllFields.sourceConversationId,
      viewCount: resultWithAllFields.viewCount,
      useCount: resultWithAllFields.useCount,
      createdAt: resultWithAllFields.createdAt.toISOString(),
      updatedAt: resultWithAllFields.updatedAt.toISOString(),
      deletedAt: resultWithAllFields.deletedAt?.toISOString() ?? null,
      tags: []
    }

    // Handle tags if provided
    if (validated.tags && validated.tags.length > 0) {
      await setPromptTags(prompt.id, validated.tags)
      // Fetch tags to include in response
      const tagResults = await getTagsForPrompt(prompt.id)
      prompt.tags = tagResults.map(t => t.name)
    }

    timer({ status: "success" })
    log.info("Prompt created successfully", { promptId: prompt.id })

    revalidatePath("/prompt-library")

    return createSuccess(prompt, "Prompt saved successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to create prompt", {
      context: "createPrompt",
      requestId,
      operation: "createPrompt"
    })
  }
}

/**
 * Get a single prompt by ID
 */
export async function getPrompt(id: string): Promise<ActionState<Prompt>> {
  const requestId = generateRequestId()
  const timer = startTimer("getPrompt")
  const log = createLogger({ requestId, action: "getPrompt" })

  try {
    log.info("Action started: Getting prompt", { promptId: id })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized prompt access attempt")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Check read access
    const canRead = await canReadPrompt(id, userId)
    if (!canRead) {
      log.warn("Prompt access denied", { promptId: id, userId })
      throw ErrorFactories.authzResourceNotFound("Prompt", id)
    }

    // Increment view count
    await incrementViewCount(id)
    log.debug("View count incremented", { promptId: id })

    // Fetch prompt with owner name and tags via Drizzle
    const result = await getPromptById(id)

    if (!result) {
      throw ErrorFactories.dbRecordNotFound("prompt_library", id)
    }

    // Convert dates to strings for Prompt type
    const prompt: Prompt = {
      id: result.id,
      userId: result.userId,
      title: result.title,
      content: result.content,
      description: result.description,
      visibility: result.visibility as 'public' | 'private',
      moderationStatus: result.moderationStatus as 'pending' | 'approved' | 'rejected',
      moderatedBy: result.moderatedBy,
      moderatedAt: result.moderatedAt?.toISOString() ?? null,
      moderationNotes: result.moderationNotes,
      sourceMessageId: result.sourceMessageId,
      sourceConversationId: result.sourceConversationId,
      viewCount: result.viewCount,
      useCount: result.useCount,
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
      deletedAt: result.deletedAt?.toISOString() ?? null,
      tags: result.tags,
      ownerName: result.ownerName ?? undefined
    }

    timer({ status: "success" })
    log.info("Prompt retrieved successfully", { promptId: id })

    return createSuccess(prompt)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to retrieve prompt", {
      context: "getPrompt",
      requestId,
      operation: "getPrompt"
    })
  }
}

/**
 * List prompts with filtering and pagination
 */
export async function listPrompts(
  params: PromptSearchInput
): Promise<ActionState<PromptListResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("listPrompts")
  const log = createLogger({ requestId, action: "listPrompts" })

  try {
    log.info("Action started: Listing prompts", {
      params: sanitizeForLogging(params)
    })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized prompt list attempt")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Validate params
    const validated = promptSearchSchema.parse(params)

    // Calculate offset for pagination
    const offset = (validated.page - 1) * validated.limit

    // Call Drizzle listPrompts with search options
    const { prompts: drizzlePrompts, total } = await drizzleListPrompts(
      {
        visibility: validated.visibility,
        tags: validated.tags,
        search: validated.search,
        filterUserId: validated.userId,
        sort: validated.sort === 'created' ? 'recent' : validated.sort,
        limit: validated.limit,
        offset
      },
      userId
    )

    // Convert dates to strings for PromptListItem type
    const prompts: PromptListItem[] = drizzlePrompts.map(p => ({
      id: p.id,
      userId: p.userId,
      title: p.title,
      preview: p.preview,
      description: p.description,
      visibility: p.visibility as 'public' | 'private',
      moderationStatus: p.moderationStatus as 'pending' | 'approved' | 'rejected',
      moderatedBy: null,       // Not included in list view
      moderatedAt: null,       // Not included in list view
      moderationNotes: null,   // Not included in list view
      sourceMessageId: null,   // Not included in list view
      sourceConversationId: null, // Not included in list view
      viewCount: p.viewCount,
      useCount: p.useCount,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      deletedAt: null,         // Excluded by query
      tags: p.tags,
      ownerName: p.ownerName ?? undefined
    }))

    const hasMore = total > validated.page * validated.limit

    timer({ status: "success" })
    log.info("Prompts listed successfully", {
      count: prompts.length,
      total,
      page: validated.page
    })

    return createSuccess({
      prompts,
      total,
      page: validated.page,
      limit: validated.limit,
      hasMore
    })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to list prompts", {
      context: "listPrompts",
      requestId,
      operation: "listPrompts"
    })
  }
}

/**
 * Update an existing prompt
 */
export async function updatePrompt(
  id: string,
  input: UpdatePromptInput
): Promise<ActionState<Prompt>> {
  const requestId = generateRequestId()
  const timer = startTimer("updatePrompt")
  const log = createLogger({ requestId, action: "updatePrompt" })

  try {
    log.info("Action started: Updating prompt", { promptId: id })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized prompt update attempt")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Check update access
    const canUpdate = await canUpdatePrompt(id, userId)
    if (!canUpdate) {
      log.warn("Prompt update denied", { promptId: id, userId })
      throw ErrorFactories.authzOwnerRequired("update this prompt")
    }

    // Validate input
    const validated = updatePromptSchema.parse(input)

    // Check if any updates requested
    const hasFieldUpdates = validated.title !== undefined ||
                           validated.content !== undefined ||
                           validated.description !== undefined ||
                           validated.visibility !== undefined

    if (!hasFieldUpdates && !validated.tags) {
      // No changes requested, fetch and return current prompt
      const getResult = await getPrompt(id)
      if (!getResult.isSuccess) {
        throw ErrorFactories.dbQueryFailed("Failed to fetch prompt")
      }
      return createSuccess(getResult.data, "No changes to update")
    }

    // Update prompt via Drizzle (handles visibility→moderation_status logic)
    if (hasFieldUpdates) {
      const result = await drizzleUpdatePrompt(id, {
        title: validated.title,
        content: validated.content,
        description: validated.description,
        visibility: validated.visibility
      })

      if (!result) {
        throw ErrorFactories.dbRecordNotFound("prompt_library", id)
      }
    }

    // Handle tag updates
    if (validated.tags !== undefined) {
      await setPromptTags(id, validated.tags)
      log.debug("Tags updated for prompt", { promptId: id, tagCount: validated.tags.length })
    }

    // Fetch updated prompt with tags
    const getResult = await getPrompt(id)
    if (!getResult.isSuccess) {
      throw ErrorFactories.dbQueryFailed("Failed to fetch updated prompt")
    }

    timer({ status: "success" })
    log.info("Prompt updated successfully", { promptId: id })

    revalidatePath("/prompt-library")

    return createSuccess(getResult.data, "Prompt updated successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update prompt", {
      context: "updatePrompt",
      requestId,
      operation: "updatePrompt",
      metadata: { promptId: id }
    })
  }
}

/**
 * Soft delete a prompt
 */
export async function deletePrompt(id: string): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deletePrompt")
  const log = createLogger({ requestId, action: "deletePrompt" })

  try {
    log.info("Action started: Deleting prompt", { promptId: id })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized prompt deletion attempt")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Check delete access
    const canDelete = await canDeletePrompt(id, userId)
    if (!canDelete) {
      log.warn("Prompt deletion denied", { promptId: id, userId })
      throw ErrorFactories.authzOwnerRequired("delete this prompt")
    }

    // Soft delete via Drizzle
    const deleted = await drizzleDeletePrompt(id)

    if (!deleted) {
      throw ErrorFactories.dbRecordNotFound("prompt_library", id)
    }

    timer({ status: "success" })
    log.info("Prompt deleted successfully", { promptId: id })

    revalidatePath("/prompt-library")

    return createSuccess(undefined, "Prompt deleted successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to delete prompt", {
      context: "deletePrompt",
      requestId,
      operation: "deletePrompt",
      metadata: { promptId: id }
    })
  }
}

/**
 * Helper: Assign tags to a prompt
 */
async function assignTagsToPrompt(
  promptId: string,
  tagNames: string[],
  log: ReturnType<typeof createLogger>
): Promise<void> {
  if (tagNames.length === 0) return

  const trimmedNames = tagNames.map(t => t.trim())

  // Batch insert tags if they don't exist using JSON
  // RDS Data API doesn't support array parameters, so we use JSON instead
  await executeSQL(
    `INSERT INTO prompt_tags (name)
     SELECT value FROM json_array_elements_text(:names::json)
     ON CONFLICT (name) DO NOTHING`,
    [
      {
        name: "names",
        value: { stringValue: JSON.stringify(trimmedNames) }
      }
    ]
  )

  // Get tag IDs using JSON array
  const tagResults = await executeSQL<{ id: number; name: string }>(
    `SELECT id, name FROM prompt_tags WHERE name IN (SELECT value FROM json_array_elements_text(:names::json))`,
    [
      {
        name: "names",
        value: { stringValue: JSON.stringify(trimmedNames) }
      }
    ]
  )

  // Validate that tags were created or found
  if (tagResults.length === 0) {
    log.error("No tags were created or found", { tagNames: trimmedNames })
    throw ErrorFactories.dbQueryFailed(
      "INSERT/SELECT prompt_tags",
      new Error("Failed to create or retrieve tags"),
      { details: { tagNames: trimmedNames } }
    )
  }

  // Batch insert associations using JSON array
  await executeSQL(
    `INSERT INTO prompt_library_tags (prompt_id, tag_id)
     SELECT :promptId::uuid, value::bigint FROM json_array_elements_text(:tagIds::json)
     ON CONFLICT DO NOTHING`,
    [
      { name: "promptId", value: { stringValue: promptId } },
      {
        name: "tagIds",
        value: { stringValue: JSON.stringify(tagResults.map(t => t.id)) }
      }
    ]
  )

  log.debug("Tags assigned to prompt", {
    promptId,
    tagCount: tagResults.length
  })
}

/**
 * Helper: Update tags for a prompt
 */
async function updateTagsForPrompt(
  promptId: string,
  tagNames: string[],
  log: ReturnType<typeof createLogger>
): Promise<void> {
  // Remove existing tags
  await executeSQL(
    `DELETE FROM prompt_library_tags WHERE prompt_id = :promptId::uuid`,
    [{ name: "promptId", value: { stringValue: promptId } }]
  )

  // Assign new tags
  if (tagNames.length > 0) {
    await assignTagsToPrompt(promptId, tagNames, log)
  }

  log.debug("Tags updated for prompt", {
    promptId,
    tagCount: tagNames.length
  })
}

/**
 * Track a prompt view event
 */
export async function trackPromptView(
  promptId: string
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("trackPromptView")
  const log = createLogger({ requestId, action: "trackPromptView" })

  try {
    log.info("Action started: Tracking prompt view", { promptId })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized prompt view tracking attempt")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Increment view count and create usage event via Drizzle
    await incrementViewCount(promptId)
    await trackUsageEvent(promptId, userId, 'view')

    timer({ status: "success" })
    log.info("Prompt view tracked", { promptId, userId })

    return createSuccess(undefined)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to track prompt view", {
      context: "trackPromptView",
      requestId,
      operation: "trackPromptView",
      metadata: { promptId }
    })
  }
}

/**
 * Track a prompt use event
 */
export async function trackPromptUse(
  promptId: string,
  conversationId?: string
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("trackPromptUse")
  const log = createLogger({ requestId, action: "trackPromptUse" })

  try {
    log.info("Action started: Tracking prompt use", {
      promptId,
      conversationId
    })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized prompt use tracking attempt")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Increment use count and create usage event via Drizzle
    await incrementUseCount(promptId)
    await trackUsageEvent(promptId, userId, 'use', conversationId)

    timer({ status: "success" })
    log.info("Prompt use tracked", { promptId, userId, conversationId })

    return createSuccess(undefined)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to track prompt use", {
      context: "trackPromptUse",
      requestId,
      operation: "trackPromptUse",
      metadata: { promptId, conversationId }
    })
  }
}

/**
 * Track a prompt share event
 */
export async function trackPromptShare(
  promptId: string
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("trackPromptShare")
  const log = createLogger({ requestId, action: "trackPromptShare" })

  try {
    log.info("Action started: Tracking prompt share", { promptId })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized prompt share tracking attempt")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Create usage event via Drizzle (no counter for shares, just events)
    await trackUsageEvent(promptId, userId, 'share')

    timer({ status: "success" })
    log.info("Prompt share tracked", { promptId, userId })

    return createSuccess(undefined)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to track prompt share", {
      context: "trackPromptShare",
      requestId,
      operation: "trackPromptShare",
      metadata: { promptId }
    })
  }
}
