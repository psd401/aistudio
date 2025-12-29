"use server"

import { getServerSession } from "@/lib/auth/server-session"
import {
  getAllTags as drizzleGetAllTags,
  getPopularTags as drizzleGetPopularTags,
  getTagsForPrompt,
  searchTagsByName,
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
import {
  canAccessPromptLibrary,
  getUserIdFromSession
} from "@/lib/prompt-library/access-control"
import type { PromptTag } from "@/lib/prompt-library/types"

/**
 * Get all available tags
 */
export async function getAllTags(): Promise<ActionState<PromptTag[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAllTags")
  const log = createLogger({ requestId, action: "getAllTags" })

  try {
    log.info("Action started: Getting all tags")

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized tags access")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Check access
    const hasAccess = await canAccessPromptLibrary(userId)
    if (!hasAccess) {
      log.warn("Tags access denied - insufficient permissions", { userId })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Get all tags with usage count
    const results = await drizzleGetAllTags()

    // Convert Date to string for PromptTag type
    const tags = results.map(tag => ({
      ...tag,
      createdAt: tag.createdAt.toISOString()
    }))

    timer({ status: "success" })
    log.info("Tags retrieved successfully", { count: tags.length })

    return createSuccess(tags)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to retrieve tags", {
      context: "getAllTags",
      requestId,
      operation: "getAllTags"
    })
  }
}

/**
 * Get popular tags
 */
export async function getPopularTags(
  limit: number = 20
): Promise<ActionState<Array<PromptTag & { usageCount: number }>>> {
  const requestId = generateRequestId()
  const timer = startTimer("getPopularTags")
  const log = createLogger({ requestId, action: "getPopularTags" })

  try {
    // Validate and clamp limit to prevent abuse
    const validatedLimit = Math.max(1, Math.min(limit, 100))

    log.info("Action started: Getting popular tags", { limit: validatedLimit })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized popular tags access")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Check access
    const hasAccess = await canAccessPromptLibrary(userId)
    if (!hasAccess) {
      log.warn("Popular tags access denied - insufficient permissions", {
        userId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Get popular tags
    const results = await drizzleGetPopularTags(validatedLimit)

    // Convert Date to string for PromptTag type
    const tags = results.map(tag => ({
      ...tag,
      createdAt: tag.createdAt.toISOString()
    }))

    timer({ status: "success" })
    log.info("Popular tags retrieved successfully", { count: tags.length })

    return createSuccess(tags)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to retrieve popular tags", {
      context: "getPopularTags",
      requestId,
      operation: "getPopularTags"
    })
  }
}

/**
 * Get tags for a specific prompt
 */
export async function getPromptTags(
  promptId: string
): Promise<ActionState<PromptTag[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getPromptTags")
  const log = createLogger({ requestId, action: "getPromptTags" })

  try {
    log.info("Action started: Getting prompt tags", { promptId })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized prompt tags access")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Check access
    const hasAccess = await canAccessPromptLibrary(userId)
    if (!hasAccess) {
      log.warn("Prompt tags access denied - insufficient permissions", {
        userId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Get tags for prompt
    const results = await getTagsForPrompt(promptId)

    // Convert Date to string for PromptTag type
    const tags = results.map(tag => ({
      ...tag,
      createdAt: tag.createdAt.toISOString()
    }))

    timer({ status: "success" })
    log.info("Prompt tags retrieved successfully", {
      promptId,
      count: tags.length
    })

    return createSuccess(tags)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to retrieve prompt tags", {
      context: "getPromptTags",
      requestId,
      operation: "getPromptTags",
      metadata: { promptId }
    })
  }
}

/**
 * Search tags by name
 */
export async function searchTags(
  query: string,
  limit: number = 10
): Promise<ActionState<PromptTag[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("searchTags")
  const log = createLogger({ requestId, action: "searchTags" })

  try {
    // Validate and clamp limit to prevent abuse
    const validatedLimit = Math.max(1, Math.min(limit, 100))

    log.info("Action started: Searching tags", { query, limit: validatedLimit })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized tag search")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdFromSession(session.sub)

    // Check access
    const hasAccess = await canAccessPromptLibrary(userId)
    if (!hasAccess) {
      log.warn("Tag search denied - insufficient permissions", { userId })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Search tags
    const results = await searchTagsByName(query, validatedLimit)

    // Convert Date to string for PromptTag type
    const tags = results.map(tag => ({
      ...tag,
      createdAt: tag.createdAt.toISOString()
    }))

    timer({ status: "success" })
    log.info("Tag search completed", { count: tags.length })

    return createSuccess(tags)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to search tags", {
      context: "searchTags",
      requestId,
      operation: "searchTags",
      metadata: { query }
    })
  }
}
