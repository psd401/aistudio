"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { executeSQL } from "@/lib/db/data-api-adapter"
import { type ActionState } from "@/types/actions-types"
import { hasToolAccess } from "@/utils/roles"
import { handleError } from "@/lib/error-utils"
import {
  createLogger,
  generateRequestId,
  startTimer
} from "@/lib/logger"

// Helper function to get user ID from session
async function getUserIdFromSession(cognitoSub: string): Promise<number | null> {
  const userResult = await executeSQL(
    "SELECT id FROM users WHERE cognito_sub = :userId",
    [{ name: 'userId', value: { stringValue: cognitoSub } }]
  )

  if (userResult.length === 0) {
    return null
  }

  return Number(userResult[0].id)
}

export interface ModelComparison {
  id: number
  prompt: string
  model1Name: string
  model2Name: string
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
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })

    const hasAccess = await hasToolAccess("model-compare")
    if (!hasAccess) {
      log.warn("Model comparisons access denied", { userId: session.sub })
      return { isSuccess: false, message: "Access denied" }
    }

    // Get user ID
    const userId = await getUserIdFromSession(session.sub)
    if (!userId) {
      log.error("User not found in database", { cognitoSub: session.sub })
      return { isSuccess: false, message: "User not found" }
    }

    log.debug("Fetching model comparisons from database", { userId, limit, offset })
    const comparisons = await executeSQL(
      `SELECT 
        id,
        prompt,
        model1_name,
        model2_name,
        response1,
        response2,
        execution_time_ms1,
        execution_time_ms2,
        tokens_used1,
        tokens_used2,
        created_at
      FROM model_comparisons
      WHERE user_id = :userId
      ORDER BY created_at DESC
      LIMIT :limit OFFSET :offset`,
      [
        { name: 'userId', value: { longValue: userId } },
        { name: 'limit', value: { longValue: limit } },
        { name: 'offset', value: { longValue: offset } }
      ]
    )

    const formattedComparisons: ModelComparison[] = comparisons.map(row => ({
      id: Number(row.id),
      prompt: String(row.prompt),
      model1Name: String(row.model1_name),
      model2Name: String(row.model2_name),
      response1: row.response1 ? String(row.response1) : null,
      response2: row.response2 ? String(row.response2) : null,
      executionTimeMs1: row.execution_time_ms1 ? Number(row.execution_time_ms1) : null,
      executionTimeMs2: row.execution_time_ms2 ? Number(row.execution_time_ms2) : null,
      tokensUsed1: row.tokens_used1 ? Number(row.tokens_used1) : null,
      tokensUsed2: row.tokens_used2 ? Number(row.tokens_used2) : null,
      createdAt: new Date(String(row.created_at))
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
      return { isSuccess: false, message: "Unauthorized" }
    }

    const hasAccess = await hasToolAccess("model-compare")
    if (!hasAccess) {
      return { isSuccess: false, message: "Access denied" }
    }

    // Get user ID
    const userId = await getUserIdFromSession(session.sub)
    if (!userId) {
      return { isSuccess: false, message: "User not found" }
    }

    log.debug("Fetching model comparison from database", { comparisonId, userId })
    const comparisons = await executeSQL(
      `SELECT 
        id,
        prompt,
        model1_name,
        model2_name,
        response1,
        response2,
        execution_time_ms1,
        execution_time_ms2,
        tokens_used1,
        tokens_used2,
        created_at
      FROM model_comparisons
      WHERE id = :comparisonId AND user_id = :userId`,
      [
        { name: 'comparisonId', value: { longValue: comparisonId } },
        { name: 'userId', value: { longValue: userId } }
      ]
    )

    if (comparisons.length === 0) {
      return { isSuccess: false, message: "Comparison not found" }
    }

    const row = comparisons[0]
    const comparison: ModelComparison = {
      id: Number(row.id),
      prompt: String(row.prompt),
      model1Name: String(row.model1_name),
      model2Name: String(row.model2_name),
      response1: row.response1 ? String(row.response1) : null,
      response2: row.response2 ? String(row.response2) : null,
      executionTimeMs1: row.execution_time_ms1 ? Number(row.execution_time_ms1) : null,
      executionTimeMs2: row.execution_time_ms2 ? Number(row.execution_time_ms2) : null,
      tokensUsed1: row.tokens_used1 ? Number(row.tokens_used1) : null,
      tokensUsed2: row.tokens_used2 ? Number(row.tokens_used2) : null,
      createdAt: new Date(String(row.created_at))
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
      return { isSuccess: false, message: "Access denied" }
    }

    // Get user ID
    const userId = await getUserIdFromSession(session.sub)
    if (!userId) {
      return { isSuccess: false, message: "User not found" }
    }

    await executeSQL(
      "DELETE FROM model_comparisons WHERE id = :comparisonId AND user_id = :userId",
      [
        { name: 'comparisonId', value: { longValue: comparisonId } },
        { name: 'userId', value: { longValue: userId } }
      ]
    )

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
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    const hasAccess = await hasToolAccess("model-compare")
    if (!hasAccess) {
      log.warn("Model comparison update access denied", { userId: session.sub })
      return { isSuccess: false, message: "Access denied" }
    }

    // Get user ID
    const userId = await getUserIdFromSession(session.sub)
    if (!userId) {
      log.error("User not found in database", { cognitoSub: session.sub })
      return { isSuccess: false, message: "User not found" }
    }

    // Verify comparison ownership and update results
    const updateResult = await executeSQL(
      `UPDATE model_comparisons 
       SET response1 = COALESCE(:response1, response1),
           response2 = COALESCE(:response2, response2),
           execution_time_ms1 = COALESCE(:executionTimeMs1, execution_time_ms1),
           execution_time_ms2 = COALESCE(:executionTimeMs2, execution_time_ms2),
           tokens_used1 = COALESCE(:tokensUsed1, tokens_used1),
           tokens_used2 = COALESCE(:tokensUsed2, tokens_used2),
           updated_at = NOW()
       WHERE id = :comparisonId AND user_id = :userId`,
      [
        { name: 'comparisonId', value: { longValue: request.comparisonId } },
        { name: 'userId', value: { longValue: userId } },
        { name: 'response1', value: request.response1 ? { stringValue: request.response1 } : { isNull: true } },
        { name: 'response2', value: request.response2 ? { stringValue: request.response2 } : { isNull: true } },
        { name: 'executionTimeMs1', value: request.executionTimeMs1 ? { longValue: request.executionTimeMs1 } : { isNull: true } },
        { name: 'executionTimeMs2', value: request.executionTimeMs2 ? { longValue: request.executionTimeMs2 } : { isNull: true } },
        { name: 'tokensUsed1', value: request.tokensUsed1 ? { longValue: request.tokensUsed1 } : { isNull: true } },
        { name: 'tokensUsed2', value: request.tokensUsed2 ? { longValue: request.tokensUsed2 } : { isNull: true } }
      ]
    )

    log.info("Comparison results updated successfully", { 
      comparisonId: request.comparisonId,
      rowsUpdated: updateResult.length 
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