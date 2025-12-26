"use server"

import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import { hasRole } from "@/utils/roles"
import { getUserIdByCognitoSub } from "@/lib/db/data-api-adapter"
import {
  getModerationQueue as drizzleGetModerationQueue,
  moderatePrompt as drizzleModeratePrompt,
  bulkModeratePrompts as drizzleBulkModeratePrompts,
  getModerationStats as drizzleGetModerationStats
} from "@/lib/db/drizzle"
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

    // Get queue via Drizzle
    const { items: drizzleItems, total } = await drizzleGetModerationQueue({
      status: status as "pending" | "approved" | "rejected" | "all",
      limit,
      offset
    })

    // Convert Date to string for response type
    const items: ModerationQueueItem[] = drizzleItems.map(item => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      creatorFirstName: item.creatorFirstName ?? '',
      creatorLastName: item.creatorLastName ?? '',
      creatorEmail: item.creatorEmail ?? ''
    }))

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
    if (Number.isNaN(userIdNum) || userIdNum <= 0) {
      log.error("Invalid user ID format", { userId })
      throw ErrorFactories.sysInternalError("Invalid user ID format")
    }

    // Validate UUID format
    if (!isValidUUID(promptId)) {
      throw ErrorFactories.invalidInput('promptId', promptId, 'Must be a valid UUID')
    }

    // Update via Drizzle
    const success = await drizzleModeratePrompt(
      promptId,
      action.status,
      userIdNum,
      action.notes
    )

    if (!success) {
      log.warn("Prompt not found or already deleted", { promptId })
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
    if (Number.isNaN(userIdNum) || userIdNum <= 0) {
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

    // Update via Drizzle
    const actualCount = await drizzleBulkModeratePrompts(
      promptIds,
      action.status,
      userIdNum,
      action.notes
    )

    // Verify at least some rows were updated
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

    // Get stats via Drizzle
    const stats = await drizzleGetModerationStats()

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
