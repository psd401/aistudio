"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { executeSQL } from "@/lib/db/data-api-adapter"
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
  PromptListResult,
  PromptTag
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

    // Create prompt with moderation_status based on visibility
    // Private prompts are auto-approved, public prompts need moderation
    const moderationStatus = validated.visibility === 'private' ? 'approved' : 'pending'

    const results = await executeSQL<Prompt>(
      `INSERT INTO prompt_library
       (user_id, title, content, description, visibility, moderation_status, source_message_id, source_conversation_id)
       VALUES (:userId, :title, :content, :description, :visibility, :moderationStatus, :sourceMessageId::uuid, :sourceConversationId::uuid)
       RETURNING *`,
      [
        { name: "userId", value: { longValue: userId } },
        { name: "title", value: { stringValue: validated.title } },
        { name: "content", value: { stringValue: validated.content } },
        {
          name: "description",
          value: validated.description
            ? { stringValue: validated.description }
            : { isNull: true }
        },
        { name: "visibility", value: { stringValue: validated.visibility } },
        { name: "moderationStatus", value: { stringValue: moderationStatus } },
        {
          name: "sourceMessageId",
          value: validated.sourceMessageId
            ? { stringValue: validated.sourceMessageId }
            : { isNull: true }
        },
        {
          name: "sourceConversationId",
          value: validated.sourceConversationId
            ? { stringValue: validated.sourceConversationId }
            : { isNull: true }
        }
      ]
    )

    if (results.length === 0) {
      throw ErrorFactories.sysInternalError("Failed to create prompt")
    }

    const prompt = transformSnakeToCamel<Prompt>(results[0])

    // Handle tags if provided
    if (validated.tags && validated.tags.length > 0) {
      await assignTagsToPrompt(prompt.id, validated.tags, log)
      // Fetch tags to include in response
      const tagResults = await executeSQL<{ name: string }>(
        `SELECT t.name
         FROM prompt_tags t
         JOIN prompt_library_tags plt ON t.id = plt.tag_id
         WHERE plt.prompt_id = :promptId`,
        [{ name: "promptId", value: { stringValue: prompt.id } }]
      )
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
    await executeSQL(
      `UPDATE prompt_library SET view_count = view_count + 1 WHERE id = :id::uuid`,
      [{ name: "id", value: { stringValue: id } }]
    )
    log.debug("View count incremented", { promptId: id })

    // Fetch prompt data (explicitly select fields like listPrompts does)
    const promptResults = await executeSQL<Omit<Prompt, 'tags'>>(
      `SELECT
        p.id,
        p.user_id,
        p.title,
        p.content,
        p.description,
        p.visibility,
        p.moderation_status,
        p.moderated_by,
        p.moderated_at,
        p.moderation_notes,
        p.source_message_id,
        p.source_conversation_id,
        p.view_count,
        p.use_count,
        p.created_at,
        p.updated_at,
        p.deleted_at,
        CONCAT(u.first_name, ' ', u.last_name) as owner_name
       FROM prompt_library p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.id = :id::uuid AND p.deleted_at IS NULL`,
      [{ name: "id", value: { stringValue: id } }]
    )

    if (promptResults.length === 0) {
      throw ErrorFactories.dbRecordNotFound("prompt_library", id)
    }

    // Fetch tags separately to ensure simple JavaScript array
    const tagResults = await executeSQL<{ name: string }>(
      `SELECT t.name
       FROM prompt_library_tags plt
       JOIN prompt_tags t ON plt.tag_id = t.id
       WHERE plt.prompt_id = :id::uuid`,
      [{ name: "id", value: { stringValue: id } }]
    )

    // Transform and combine results with explicit type handling
    const transformedPrompt = transformSnakeToCamel<Omit<Prompt, 'tags'>>(promptResults[0])

    const prompt: Prompt = {
      ...transformedPrompt,
      tags: tagResults.map(t => t.name), // Simple JavaScript array
      // Explicitly ensure all dates are strings for Next.js serialization
      createdAt: String(transformedPrompt.createdAt || ''),
      updatedAt: String(transformedPrompt.updatedAt || ''),
      moderatedAt: transformedPrompt.moderatedAt ? String(transformedPrompt.moderatedAt) : null,
      deletedAt: transformedPrompt.deletedAt ? String(transformedPrompt.deletedAt) : null,
    }

    // Verify serialization before returning
    try {
      JSON.stringify(prompt)
      log.info("Prompt serialization verified", { promptId: id })
    } catch (serializationError) {
      log.error("Prompt serialization failed", {
        error: serializationError,
        promptKeys: Object.keys(prompt),
        promptTypes: Object.entries(prompt).map(([k, v]) => `${k}: ${typeof v}`)
      })
      throw new Error("Failed to serialize prompt data for Next.js")
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

    // Build query conditions
    const conditions = ["p.deleted_at IS NULL"]
    const parameters: Array<{ name: string; value: any }> = []

    // Visibility filter
    if (validated.visibility === 'private') {
      conditions.push("p.user_id = :userId")
      parameters.push({ name: "userId", value: { longValue: userId } })
    } else if (validated.visibility === 'public') {
      conditions.push("p.visibility = 'public' AND p.moderation_status = 'approved'")
    } else {
      // Show user's own prompts OR approved public prompts
      conditions.push(
        "(p.user_id = :userId OR (p.visibility = 'public' AND p.moderation_status = 'approved'))"
      )
      parameters.push({ name: "userId", value: { longValue: userId } })
    }

    // Tag filter
    if (validated.tags && validated.tags.length > 0) {
      conditions.push(`
        EXISTS (
          SELECT 1 FROM prompt_library_tags plt
          JOIN prompt_tags t ON plt.tag_id = t.id
          WHERE plt.prompt_id = p.id
          AND t.name = ANY(:tags)
        )
      `)
      parameters.push({
        name: "tags",
        value: { arrayValue: { stringValues: validated.tags } }
      })
    }

    // Search filter
    if (validated.search) {
      conditions.push(`
        (p.title ILIKE :search
         OR p.description ILIKE :search
         OR p.content ILIKE :search)
      `)
      const searchPattern = `%${validated.search}%`
      parameters.push({
        name: "search",
        value: { stringValue: searchPattern }
      })
    }

    // User filter (for viewing specific user's prompts)
    if (validated.userId) {
      conditions.push("p.user_id = :filterUserId")
      parameters.push({
        name: "filterUserId",
        value: { longValue: validated.userId }
      })
    }

    // Sort order
    let orderBy = "p.created_at DESC"
    if (validated.sort === 'usage') {
      orderBy = "p.use_count DESC, p.created_at DESC"
    } else if (validated.sort === 'views') {
      orderBy = "p.view_count DESC, p.created_at DESC"
    }

    // Calculate offset
    const offset = (validated.page - 1) * validated.limit

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM prompt_library p
      WHERE ${conditions.join(" AND ")}
    `
    const countResults = await executeSQL<{ total: number }>(
      countQuery,
      parameters
    )
    const total = countResults[0]?.total || 0

    // Get prompts
    const query = `
      SELECT
        p.id,
        p.user_id,
        p.title,
        LEFT(p.content, 200) as preview,
        p.description,
        p.visibility,
        p.moderation_status,
        p.view_count,
        p.use_count,
        p.created_at,
        p.updated_at,
        array_agg(DISTINCT t.name) FILTER (WHERE t.id IS NOT NULL) as tags,
        CONCAT(u.first_name, ' ', u.last_name) as owner_name
      FROM prompt_library p
      LEFT JOIN prompt_library_tags plt ON p.id = plt.prompt_id
      LEFT JOIN prompt_tags t ON plt.tag_id = t.id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE ${conditions.join(" AND ")}
      GROUP BY p.id, u.first_name, u.last_name
      ORDER BY ${orderBy}
      LIMIT :limit OFFSET :offset
    `

    parameters.push(
      { name: "limit", value: { longValue: validated.limit } },
      { name: "offset", value: { longValue: offset } }
    )

    const results = await executeSQL<PromptListItem>(query, parameters)
    const prompts = results.map(r => transformSnakeToCamel<PromptListItem>(r))

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

    // Build update fields
    const fields: string[] = []
    const parameters: Array<{ name: string; value: any }> = [
      { name: "id", value: { stringValue: id } }
    ]

    if (validated.title !== undefined) {
      fields.push("title = :title")
      parameters.push({ name: "title", value: { stringValue: validated.title } })
    }

    if (validated.content !== undefined) {
      fields.push("content = :content")
      parameters.push({
        name: "content",
        value: { stringValue: validated.content }
      })
    }

    if (validated.description !== undefined) {
      fields.push("description = :description")
      parameters.push({
        name: "description",
        value: validated.description
          ? { stringValue: validated.description }
          : { isNull: true }
      })
    }

    if (validated.visibility !== undefined) {
      fields.push("visibility = :visibility")
      parameters.push({
        name: "visibility",
        value: { stringValue: validated.visibility }
      })

      // Reset moderation status based on visibility
      if (validated.visibility === 'public') {
        // Public prompts need moderation
        fields.push("moderation_status = 'pending'")
        fields.push("moderated_by = NULL")
        fields.push("moderated_at = NULL")
        fields.push("moderation_notes = NULL")
      } else if (validated.visibility === 'private') {
        // Private prompts are auto-approved
        fields.push("moderation_status = 'approved'")
        fields.push("moderated_by = NULL")
        fields.push("moderated_at = NULL")
        fields.push("moderation_notes = NULL")
      }
    }

    if (fields.length === 0 && !validated.tags) {
      // No changes requested, fetch and return current prompt
      const getResult = await getPrompt(id)
      if (!getResult.isSuccess) {
        throw new Error("Failed to fetch prompt")
      }
      return createSuccess(getResult.data, "No changes to update")
    }

    // Update prompt
    if (fields.length > 0) {
      fields.push("updated_at = CURRENT_TIMESTAMP")

      const updateQuery = `
        UPDATE prompt_library
        SET ${fields.join(", ")}
        WHERE id = :id::uuid AND deleted_at IS NULL
        RETURNING *
      `

      const results = await executeSQL<Prompt>(updateQuery, parameters)

      if (results.length === 0) {
        throw ErrorFactories.dbRecordNotFound("prompt_library", id)
      }
    }

    // Handle tag updates
    if (validated.tags !== undefined) {
      await updateTagsForPrompt(id, validated.tags, log)
    }

    // Fetch updated prompt with tags
    const getResult = await getPrompt(id)
    if (!getResult.isSuccess) {
      throw new Error("Failed to fetch updated prompt")
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

    // Soft delete
    await executeSQL(
      `UPDATE prompt_library
       SET deleted_at = CURRENT_TIMESTAMP
       WHERE id = :id::uuid AND deleted_at IS NULL`,
      [{ name: "id", value: { stringValue: id } }]
    )

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
  const tagResults = await executeSQL<{ id: number }>(
    `SELECT id FROM prompt_tags WHERE name IN (SELECT value FROM json_array_elements_text(:names::json))`,
    [
      {
        name: "names",
        value: { stringValue: JSON.stringify(trimmedNames) }
      }
    ]
  )

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

    // Increment view count
    await executeSQL(
      `UPDATE prompt_library
       SET view_count = view_count + 1
       WHERE id = :promptId::uuid AND deleted_at IS NULL`,
      [{ name: "promptId", value: { stringValue: promptId } }]
    )

    // Create usage event
    await executeSQL(
      `INSERT INTO prompt_usage_events (prompt_id, user_id, event_type)
       VALUES (:promptId::uuid, :userId, 'view')`,
      [
        { name: "promptId", value: { stringValue: promptId } },
        { name: "userId", value: { longValue: userId } }
      ]
    )

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

    // Increment use count
    await executeSQL(
      `UPDATE prompt_library
       SET use_count = use_count + 1
       WHERE id = :promptId::uuid AND deleted_at IS NULL`,
      [{ name: "promptId", value: { stringValue: promptId } }]
    )

    // Create usage event
    await executeSQL(
      `INSERT INTO prompt_usage_events (prompt_id, user_id, event_type, conversation_id)
       VALUES (:promptId::uuid, :userId, 'use', :conversationId::uuid)`,
      [
        { name: "promptId", value: { stringValue: promptId } },
        { name: "userId", value: { longValue: userId } },
        {
          name: "conversationId",
          value: conversationId
            ? { stringValue: conversationId }
            : { isNull: true }
        }
      ]
    )

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

    // Create usage event (no counter for shares, just events)
    await executeSQL(
      `INSERT INTO prompt_usage_events (prompt_id, user_id, event_type)
       VALUES (:promptId::uuid, :userId, 'share')`,
      [
        { name: "promptId", value: { stringValue: promptId } },
        { name: "userId", value: { longValue: userId } }
      ]
    )

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
