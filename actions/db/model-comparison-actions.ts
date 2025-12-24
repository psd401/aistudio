"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { type ActionState } from "@/types/actions-types"
import { hasToolAccess } from "@/utils/roles"
import { handleError, ErrorFactories } from "@/lib/error-utils"
import {
  createLogger,
  generateRequestId,
  startTimer
} from "@/lib/logger"
// Drizzle ORM operations
import {
  getComparisonByIdForUser,
  getComparisonsByUserId,
  updateComparisonResults as drizzleUpdateComparisonResults,
  deleteComparison,
  getComparisonUserIdByCognitoSub,
} from "@/lib/db/drizzle"

export interface ModelComparison {
  id: number
  prompt: string
  model1Name: string | null
  model2Name: string | null
  response1: string | null
  response2: string | null
  executionTimeMs1: number | null
  executionTimeMs2: number | null
  tokensUsed1: number | null
  tokensUsed2: number | null
  createdAt: Date
}

export async function getModelComparisons(
  limit: number = 20,
  offset: number = 0
): Promise<ActionState<ModelComparison[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getModelComparisons")
  const log = createLogger({ requestId, action: "getModelComparisons" })

  try {
    log.info("Action started: Getting model comparisons", { limit, offset })

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized model comparisons access attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("User authenticated", { userId: session.sub })

    const hasAccess = await hasToolAccess("model-compare")
    if (!hasAccess) {
      log.warn("Model comparisons access denied", { userId: session.sub })
      return { isSuccess: false, message: "Access denied" }
    }

    // Get user ID using Drizzle
    const userId = await getComparisonUserIdByCognitoSub(session.sub)
    if (!userId) {
      log.error("User not found in database", { cognitoSub: session.sub })
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    log.debug("Fetching model comparisons from database", { userId, limit, offset })

    // Get comparisons using Drizzle
    const drizzleComparisons = await getComparisonsByUserId(userId, limit, offset)

    const formattedComparisons: ModelComparison[] = drizzleComparisons
      .filter(row => {
        // Log and filter out records with null createdAt (data integrity issue)
        if (row.createdAt === null) {
          log.error("Comparison has null createdAt - data integrity issue", {
            comparisonId: row.id
          })
          return false
        }
        return true
      })
      .map(row => ({
        id: row.id,
        prompt: row.prompt,
        model1Name: row.model1Name,
        model2Name: row.model2Name,
        response1: row.response1,
        response2: row.response2,
        executionTimeMs1: row.executionTimeMs1,
        executionTimeMs2: row.executionTimeMs2,
        tokensUsed1: row.tokensUsed1,
        tokensUsed2: row.tokensUsed2,
        createdAt: row.createdAt!
      }))

    log.info("Model comparisons retrieved successfully", { count: formattedComparisons.length })
    timer({ status: "success", count: formattedComparisons.length })

    return {
      isSuccess: true,
      message: "Comparisons retrieved successfully",
      data: formattedComparisons
    }
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to retrieve comparisons", {
      context: "getModelComparisons",
      requestId
    })
  }
}

export async function getModelComparison(
  comparisonId: number
): Promise<ActionState<ModelComparison>> {
  const requestId = generateRequestId()
  const timer = startTimer("getModelComparison")
  const log = createLogger({ requestId, action: "getModelComparison" })

  try {
    log.info("Action started: Getting model comparison", { comparisonId })

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized model comparison access attempt")
      throw ErrorFactories.authNoSession()
    }

    const hasAccess = await hasToolAccess("model-compare")
    if (!hasAccess) {
      throw ErrorFactories.authzInsufficientPermissions("model-compare tool")
    }

    // Get user ID using Drizzle
    const userId = await getComparisonUserIdByCognitoSub(session.sub)
    if (!userId) {
      return { isSuccess: false, message: "User not found" }
    }

    log.debug("Fetching model comparison from database", { comparisonId, userId })

    // Get comparison using Drizzle
    const drizzleComparison = await getComparisonByIdForUser(comparisonId, userId)

    if (!drizzleComparison) {
      return { isSuccess: false, message: "Comparison not found" }
    }

    if (!drizzleComparison.createdAt) {
      log.error("Comparison has null createdAt - data integrity issue", { comparisonId })
      return { isSuccess: false, message: "Invalid comparison record" }
    }

    const comparison: ModelComparison = {
      id: drizzleComparison.id,
      prompt: drizzleComparison.prompt,
      model1Name: drizzleComparison.model1Name,
      model2Name: drizzleComparison.model2Name,
      response1: drizzleComparison.response1,
      response2: drizzleComparison.response2,
      executionTimeMs1: drizzleComparison.executionTimeMs1,
      executionTimeMs2: drizzleComparison.executionTimeMs2,
      tokensUsed1: drizzleComparison.tokensUsed1,
      tokensUsed2: drizzleComparison.tokensUsed2,
      createdAt: drizzleComparison.createdAt
    }

    log.info("Model comparison retrieved successfully", { comparisonId })
    timer({ status: "success", comparisonId })

    return {
      isSuccess: true,
      message: "Comparison retrieved successfully",
      data: comparison
    }
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to retrieve comparison", {
      context: "getModelComparison",
      requestId
    })
  }
}

export async function deleteModelComparison(
  comparisonId: number
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteModelComparison")
  const log = createLogger({ requestId, action: "deleteModelComparison" })

  try {
    log.info("Action started: Deleting model comparison", { comparisonId })

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized model comparison deletion attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }

    const hasAccess = await hasToolAccess("model-compare")
    if (!hasAccess) {
      throw ErrorFactories.authzInsufficientPermissions("model-compare tool")
    }

    // Get user ID using Drizzle
    const userId = await getComparisonUserIdByCognitoSub(session.sub)
    if (!userId) {
      return { isSuccess: false, message: "User not found" }
    }

    // Delete using Drizzle
    await deleteComparison(comparisonId, userId)

    log.info("Model comparison deleted successfully", { comparisonId })
    timer({ status: "success", comparisonId })

    return {
      isSuccess: true,
      message: "Comparison deleted successfully",
      data: undefined
    }
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to delete comparison", {
      context: "deleteModelComparison",
      requestId
    })
  }
}

export interface UpdateComparisonResultsRequest {
  comparisonId: number
  response1?: string
  response2?: string
  executionTimeMs1?: number
  executionTimeMs2?: number
  tokensUsed1?: number
  tokensUsed2?: number
}

export async function updateComparisonResults(
  request: UpdateComparisonResultsRequest
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateComparisonResults")
  const log = createLogger({ requestId, action: "updateComparisonResults" })

  try {
    log.info("Action started: Updating comparison results", {
      comparisonId: request.comparisonId,
      hasResponse1: !!request.response1,
      hasResponse2: !!request.response2
    })

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized comparison update attempt")
      throw ErrorFactories.authNoSession()
    }

    const hasAccess = await hasToolAccess("model-compare")
    if (!hasAccess) {
      log.warn("Model comparison update access denied", { userId: session.sub })
      return { isSuccess: false, message: "Access denied" }
    }

    // Get user ID using Drizzle
    const userId = await getComparisonUserIdByCognitoSub(session.sub)
    if (!userId) {
      log.error("User not found in database", { cognitoSub: session.sub })
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    // Update using Drizzle
    const updatedComparison = await drizzleUpdateComparisonResults(request.comparisonId, userId, {
      response1: request.response1,
      response2: request.response2,
      executionTimeMs1: request.executionTimeMs1,
      executionTimeMs2: request.executionTimeMs2,
      tokensUsed1: request.tokensUsed1,
      tokensUsed2: request.tokensUsed2,
    })

    if (!updatedComparison) {
      log.error("Failed to update comparison - record not found or no permission", {
        comparisonId: request.comparisonId,
        userId
      })
      return { isSuccess: false, message: "Comparison not found or access denied" }
    }

    log.info("Comparison results updated successfully", {
      comparisonId: request.comparisonId
    })

    timer({ status: "success", comparisonId: request.comparisonId })

    return {
      isSuccess: true,
      message: "Comparison results updated successfully",
      data: undefined
    }
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update comparison results", {
      context: "updateComparisonResults",
      requestId
    })
  }
}
