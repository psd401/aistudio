"use server"

import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import { hasRole } from "@/utils/roles"
import { executeSQL, createParameter, getUserIdByCognitoSub } from "@/lib/db/data-api-adapter"
import { transformSnakeToCamel } from "@/lib/db/field-mapper"
import type { ActionState } from "@/types/actions-types"

export interface ModerationQueueItem {
  id: string
  userId: number
  title: string
  content: string
  description: string | null
  visibility: string
  moderationStatus: string
  createdAt: string
  updatedAt: string
  creatorFirstName: string
  creatorLastName: string
  creatorEmail: string
  viewCount: number
  useCount: number
  tags: string[]
}

export interface ModerationAction {
  status: 'approved' | 'rejected'
  notes?: string
}

// Allowed moderation statuses
const ALLOWED_STATUSES = ['pending', 'approved', 'rejected', 'all'] as const
type ModerationStatus = typeof ALLOWED_STATUSES[number]

/**
 * UUID validation helper
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
  return uuidRegex.test(uuid)
}

/**
 * Get the moderation queue with filtering options
 */
export async function getModerationQueue(
  filters: {
    status?: string
    limit?: number
    offset?: number
  } = {}
): Promise<ActionState<{ items: ModerationQueueItem[]; total: number }>> {
  const requestId = generateRequestId()
  const timer = startTimer("getModerationQueue")
  const log = createLogger({ requestId, action: "getModerationQueue" })

  try {
    log.info("Fetching moderation queue", { filters: sanitizeForLogging(filters) })

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized access attempt")
      throw ErrorFactories.authNoSession()
    }

    const isAdmin = await hasRole('administrator')
    if (!isAdmin) {
      log.warn("Non-admin user attempted to access moderation queue", { cognitoSub: session.sub })
      throw ErrorFactories.authzAdminRequired("access moderation queue")
    }

    const { status = 'pending', limit = 50, offset = 0 } = filters

    // Validate status parameter
    if (!ALLOWED_STATUSES.includes(status as ModerationStatus)) {
      throw ErrorFactories.invalidInput('status', status, 'Must be pending, approved, rejected, or all')
    }

    // Validate pagination parameters
    if (limit < 1 || limit > 100) {
      throw ErrorFactories.invalidInput('limit', limit, 'Must be between 1 and 100')
    }

    if (offset < 0) {
      throw ErrorFactories.invalidInput('offset', offset, 'Must be non-negative')
    }

    // Build the query - fix WHERE clause for 'all' status
    // ONLY show public prompts in moderation queue (private prompts should never need moderation)
    const whereClause = status === 'all'
      ? 'WHERE p.visibility = \'public\' AND p.deleted_at IS NULL'
      : 'WHERE p.visibility = \'public\' AND p.moderation_status = :status AND p.deleted_at IS NULL'

    const query = `
      SELECT
        p.id,
        p.user_id,
        p.title,
        p.content,
        p.description,
        p.visibility,
        p.moderation_status,
        p.created_at,
        p.updated_at,
        p.view_count,
        p.use_count,
        u.first_name as creator_first_name,
        u.last_name as creator_last_name,
        u.email as creator_email,
        COALESCE(
          ARRAY_AGG(DISTINCT pt.name) FILTER (WHERE pt.name IS NOT NULL),
          ARRAY[]::VARCHAR[]
        ) as tags
      FROM prompt_library p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN prompt_library_tags plt ON p.id = plt.prompt_id
      LEFT JOIN prompt_tags pt ON plt.tag_id = pt.id
      ${whereClause}
      GROUP BY p.id, u.id, u.first_name, u.last_name, u.email
      ORDER BY p.created_at DESC
      LIMIT :limit OFFSET :offset
    `

    const countQuery = `
      SELECT COUNT(*) as total
      FROM prompt_library p
      ${whereClause}
    `

    const queryParams = status === 'all'
      ? [
          createParameter('limit', limit),
          createParameter('offset', offset)
        ]
      : [
          createParameter('status', status),
          createParameter('limit', limit),
          createParameter('offset', offset)
        ]

    const countParams = status === 'all'
      ? []
      : [createParameter('status', status)]

    const [itemsResult, countResult] = await Promise.all([
      executeSQL(query, queryParams),
      executeSQL(countQuery, countParams)
    ])

    const items = itemsResult.map((row: Record<string, unknown>) => transformSnakeToCamel<ModerationQueueItem>(row))
    const total = Number(countResult[0]?.total || 0)

    timer({ status: "success" })
    log.info("Moderation queue fetched successfully", { count: items.length, total })

    return createSuccess({ items, total }, "Queue fetched successfully")

  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch moderation queue", {
      context: "getModerationQueue",
      requestId,
      operation: "getModerationQueue"
    })
  }
}

/**
 * Moderate a single prompt (approve or reject)
 */
export async function moderatePrompt(
  promptId: string,
  action: ModerationAction
): Promise<ActionState<{ success: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("moderatePrompt")
  const log = createLogger({ requestId, action: "moderatePrompt" })

  try {
    log.info("Moderating prompt", { promptId, action: sanitizeForLogging(action) })

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized moderation attempt")
      throw ErrorFactories.authNoSession()
    }

    const isAdmin = await hasRole('administrator')
    if (!isAdmin) {
      log.warn("Non-admin user attempted to moderate prompt", { cognitoSub: session.sub })
      throw ErrorFactories.authzAdminRequired("moderate prompts")
    }

    // Get the database user ID from the Cognito sub
    const userId = await getUserIdByCognitoSub(session.sub)
    if (!userId) {
      log.error("Could not find user ID for Cognito sub", { cognitoSub: session.sub })
      throw ErrorFactories.authNoSession()
    }

    // Convert string to number for INTEGER column (moderated_by is INTEGER in database)
    const userIdNum = Number.parseInt(userId, 10)
    if (isNaN(userIdNum) || userIdNum <= 0) {
      log.error("Invalid user ID format", { userId })
      throw ErrorFactories.sysInternalError("Invalid user ID format")
    }

    // Validate UUID format
    if (!isValidUUID(promptId)) {
      throw ErrorFactories.invalidInput('promptId', promptId, 'Must be a valid UUID')
    }

    const query = `
      UPDATE prompt_library
      SET
        moderation_status = :status,
        moderated_by = :moderatedBy,
        moderated_at = CURRENT_TIMESTAMP,
        moderation_notes = :notes,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = :promptId::uuid
      AND deleted_at IS NULL
      RETURNING id
    `

    const result = await executeSQL(query, [
      createParameter('status', action.status),
      createParameter('moderatedBy', userIdNum),
      createParameter('notes', action.notes || ''),
      createParameter('promptId', promptId)
    ])

    // Log the result for debugging
    log.info("Update query result", { result, resultType: typeof result, resultLength: result?.length })

    // Verify the update actually affected a row
    if (!result || !Array.isArray(result) || result.length === 0) {
      log.warn("Prompt not found or already deleted", { promptId, result })
      throw ErrorFactories.dbRecordNotFound('prompt_library', promptId)
    }

    timer({ status: "success" })
    log.info("Prompt moderated successfully", { promptId, status: action.status })

    return createSuccess(
      { success: true },
      `Prompt ${action.status} successfully`
    )

  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to moderate prompt", {
      context: "moderatePrompt",
      requestId,
      operation: "moderatePrompt"
    })
  }
}

/**
 * Bulk moderate multiple prompts
 */
export async function bulkModeratePrompts(
  promptIds: string[],
  action: ModerationAction
): Promise<ActionState<{ success: boolean; count: number }>> {
  const requestId = generateRequestId()
  const timer = startTimer("bulkModeratePrompts")
  const log = createLogger({ requestId, action: "bulkModeratePrompts" })

  try {
    log.info("Bulk moderating prompts", { count: promptIds.length, action: sanitizeForLogging(action) })

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized bulk moderation attempt")
      throw ErrorFactories.authNoSession()
    }

    const isAdmin = await hasRole('administrator')
    if (!isAdmin) {
      log.warn("Non-admin user attempted bulk moderation", { cognitoSub: session.sub })
      throw ErrorFactories.authzAdminRequired("bulk moderate prompts")
    }

    // Get the database user ID from the Cognito sub
    const userId = await getUserIdByCognitoSub(session.sub)
    if (!userId) {
      log.error("Could not find user ID for Cognito sub", { cognitoSub: session.sub })
      throw ErrorFactories.authNoSession()
    }

    // Convert string to number for INTEGER column (moderated_by is INTEGER in database)
    const userIdNum = Number.parseInt(userId, 10)
    if (isNaN(userIdNum) || userIdNum <= 0) {
      log.error("Invalid user ID format", { userId })
      throw ErrorFactories.sysInternalError("Invalid user ID format")
    }

    if (promptIds.length === 0) {
      throw ErrorFactories.missingRequiredField("promptIds")
    }

    if (promptIds.length > 100) {
      throw ErrorFactories.invalidInput("promptIds", promptIds.length, "Maximum 100 prompts")
    }

    // Validate all UUIDs
    const invalidIds = promptIds.filter(id => !isValidUUID(id))
    if (invalidIds.length > 0) {
      throw ErrorFactories.invalidInput(
        'promptIds',
        invalidIds,
        `Contains ${invalidIds.length} invalid UUID(s)`
      )
    }

    // Build the IN clause for the query with UUID casting
    const placeholders = promptIds.map((_, i) => `:id${i}::uuid`).join(', ')
    const params = [
      createParameter('status', action.status),
      createParameter('moderatedBy', userIdNum),
      createParameter('notes', action.notes || ''),
      ...promptIds.map((id, i) => createParameter(`id${i}`, id))
    ]

    const query = `
      UPDATE prompt_library
      SET
        moderation_status = :status,
        moderated_by = :moderatedBy,
        moderated_at = CURRENT_TIMESTAMP,
        moderation_notes = :notes,
        updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
      AND deleted_at IS NULL
      RETURNING id
    `

    const result = await executeSQL(query, params)

    // Verify at least some rows were updated
    const actualCount = result.length
    if (actualCount === 0) {
      throw ErrorFactories.dbRecordNotFound('prompt_library', `bulk operation - no prompts found`)
    }

    // Log if fewer prompts were updated than requested (some may have been deleted)
    if (actualCount < promptIds.length) {
      log.warn("Some prompts were not found during bulk moderation", {
        requested: promptIds.length,
        updated: actualCount
      })
    }

    timer({ status: "success" })
    log.info("Bulk moderation completed", { count: promptIds.length, status: action.status })

    return createSuccess(
      { success: true, count: promptIds.length },
      `Successfully ${action.status} ${promptIds.length} prompts`
    )

  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to bulk moderate prompts", {
      context: "bulkModeratePrompts",
      requestId,
      operation: "bulkModeratePrompts"
    })
  }
}

/**
 * Get moderation statistics
 */
export async function getModerationStats(): Promise<ActionState<{
  pending: number
  approved: number
  rejected: number
  totalToday: number
}>> {
  const requestId = generateRequestId()
  const timer = startTimer("getModerationStats")
  const log = createLogger({ requestId, action: "getModerationStats" })

  try {
    log.info("Fetching moderation statistics")

    const session = await getServerSession()
    if (!session) {
      throw ErrorFactories.authNoSession()
    }

    const isAdmin = await hasRole('administrator')
    if (!isAdmin) {
      throw ErrorFactories.authzAdminRequired("view moderation statistics")
    }

    const query = `
      SELECT
        COUNT(*) FILTER (WHERE moderation_status = 'pending') as pending,
        COUNT(*) FILTER (WHERE moderation_status = 'approved') as approved,
        COUNT(*) FILTER (WHERE moderation_status = 'rejected') as rejected,
        COUNT(*) FILTER (WHERE moderated_at >= CURRENT_DATE) as total_today
      FROM prompt_library
      WHERE visibility = 'public' AND deleted_at IS NULL
    `

    const result = await executeSQL(query, [])
    const rawStats = result[0] as Record<string, unknown>
    const stats = {
      pending: Number(rawStats.pending || 0),
      approved: Number(rawStats.approved || 0),
      rejected: Number(rawStats.rejected || 0),
      totalToday: Number(rawStats.total_today || 0)
    }

    timer({ status: "success" })
    log.info("Stats fetched successfully", stats)

    return createSuccess(stats, "Statistics fetched successfully")

  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch moderation statistics", {
      context: "getModerationStats",
      requestId,
      operation: "getModerationStats"
    })
  }
}
