/**
 * Access control for Prompt Library
 */

import { executeSQL } from "@/lib/db/data-api-adapter"
import { hasToolAccess, hasRole } from "@/utils/roles"
import { createLogger, generateRequestId } from "@/lib/logger"

/**
 * Check if user can access the Prompt Library feature
 */
export async function canAccessPromptLibrary(userId?: number): Promise<boolean> {
  if (!userId) return false

  // Using existing tool access system
  return await hasToolAccess("knowledge-repositories")
}

/**
 * Check if user can moderate prompts (admin only)
 */
 
export async function canModeratePrompts(_userId: number): Promise<boolean> {
  // Use role-based access control (matches pattern used throughout codebase)
  // Note: hasRole checks the current session, userId parameter kept for API compatibility
  return await hasRole('administrator')
}

/**
 * Check if user can read a prompt
 */
export async function canReadPrompt(
  promptId: string,
  userId: number
): Promise<boolean> {
  const results = await executeSQL<{
    userId: number
    visibility: string
    moderationStatus: string
    deletedAt: string | null
  }>(
    `SELECT user_id, visibility, moderation_status, deleted_at
     FROM prompt_library
     WHERE id = :promptId::uuid`,
    [{ name: "promptId", value: { stringValue: promptId } }]
  )

  if (results.length === 0 || results[0].deletedAt) {
    return false
  }

  const prompt = results[0]

  // Owner can always read their own prompts - ensure numeric comparison
  if (Number(prompt.userId) === Number(userId)) {
    return true
  }

  // Public prompts must be approved to be visible to others
  if (prompt.visibility === 'public' && prompt.moderationStatus === 'approved') {
    return true
  }

  // Admins can read any prompt
  const isAdmin = await canModeratePrompts(userId)
  if (isAdmin) {
    return true
  }

  return false
}

/**
 * Check if user can update a prompt
 */
export async function canUpdatePrompt(
  promptId: string,
  userId: number
): Promise<boolean> {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, context: "canUpdatePrompt" })

  log.info("Permission check started", { promptId, userId })

  const results = await executeSQL<{ userId: number; deletedAt: string | null }>(
    `SELECT user_id, deleted_at FROM prompt_library WHERE id = :promptId::uuid`,
    [{ name: "promptId", value: { stringValue: promptId } }]
  )

  if (results.length === 0) {
    log.warn("Prompt not found", { promptId })
    return false
  }

  if (results[0].deletedAt) {
    log.warn("Prompt is deleted", { promptId, deletedAt: results[0].deletedAt })
    return false
  }

  // Get the raw database value (field is transformed from user_id to userId by data-api-adapter)
  const dbUserId = results[0].userId
  const dbUserIdType = typeof dbUserId

  // Convert both to numbers with validation
  const promptUserId = Number(dbUserId)
  const sessionUserId = Number(userId)

  // Validate conversions succeeded
  const promptUserIdIsValid = !isNaN(promptUserId) && isFinite(promptUserId)
  const sessionUserIdIsValid = !isNaN(sessionUserId) && isFinite(sessionUserId)

  // Comprehensive debug logging
  log.info("Permission check comparison", {
    promptId,
    dbUserId,
    dbUserIdType,
    promptUserId,
    promptUserIdIsValid,
    sessionUserId,
    sessionUserIdIsValid,
    sessionUserIdType: typeof userId,
    comparisonResult: promptUserId === sessionUserId
  })

  // If either conversion failed, log error and deny access
  if (!promptUserIdIsValid) {
    log.error("Invalid prompt user_id conversion", {
      promptId,
      dbUserId,
      dbUserIdType,
      promptUserId
    })
    return false
  }

  if (!sessionUserIdIsValid) {
    log.error("Invalid session userId conversion", {
      promptId,
      userId,
      sessionUserId,
      inputType: typeof userId
    })
    return false
  }

  const isOwner = promptUserId === sessionUserId

  if (!isOwner) {
    log.warn("Permission denied - not owner", {
      promptId,
      promptUserId,
      sessionUserId
    })
  } else {
    log.info("Permission granted - owner match", {
      promptId,
      userId: promptUserId
    })
  }

  return isOwner
}

/**
 * Check if user can delete a prompt
 */
export async function canDeletePrompt(
  promptId: string,
  userId: number
): Promise<boolean> {
  const results = await executeSQL<{ userId: number; deletedAt: string | null }>(
    `SELECT user_id, deleted_at FROM prompt_library WHERE id = :promptId::uuid`,
    [{ name: "promptId", value: { stringValue: promptId } }]
  )

  if (results.length === 0 || results[0].deletedAt) {
    return false
  }

  const prompt = results[0]

  // Owner can delete their own prompts - ensure numeric comparison
  if (Number(prompt.userId) === Number(userId)) {
    return true
  }

  // Admins can delete any prompt
  return await canModeratePrompts(userId)
}

/**
 * Get user ID from session cognito_sub
 */
export async function getUserIdFromSession(cognitoSub: string): Promise<number> {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, context: "getUserIdFromSession" })

  log.info("Looking up user ID", { cognitoSubPrefix: cognitoSub.substring(0, 8) })

  const results = await executeSQL<{ id: number }>(
    `SELECT id FROM users WHERE cognito_sub = :cognitoSub`,
    [{ name: "cognitoSub", value: { stringValue: cognitoSub } }]
  )

  if (results.length === 0) {
    log.error("User not found for cognito_sub", { cognitoSubPrefix: cognitoSub.substring(0, 8) })
    throw new Error(`User not found for cognito_sub: ${cognitoSub}`)
  }

  const userId = results[0].id
  const userIdType = typeof userId

  log.info("User ID found", {
    userId,
    userIdType,
    isValidNumber: !isNaN(Number(userId)) && isFinite(Number(userId))
  })

  return userId
}
