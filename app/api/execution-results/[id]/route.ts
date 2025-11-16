import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { ErrorFactories } from "@/lib/error-utils"
import { executeSQL } from "@/lib/db/data-api-adapter"
import { transformSnakeToCamel } from "@/lib/db/field-mapper"
import type { SqlParameter } from "@aws-sdk/client-rds-data"

interface ExecutionResult {
  id: number
  scheduledExecutionId: number
  resultData: Record<string, unknown>
  status: 'success' | 'failed' | 'running'
  executedAt: string
  executionDurationMs: number
  errorMessage: string | null
  scheduleName: string
  userId: number
  assistantArchitectName: string
}

async function getHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId()
  const timer = startTimer("GET /api/execution-results/[id]")
  const log = createLogger({ requestId, endpoint: "GET /api/execution-results/[id]" })

  try {
    const { id } = await params
    log.info("Fetching execution result", { resultId: sanitizeForLogging(id) })

    // Validate ID parameter
    const resultId = Number.parseInt(id, 10)
    if (!Number.isInteger(resultId) || resultId <= 0) {
      throw ErrorFactories.invalidInput("id", id, "must be a positive integer")
    }

    // Auth check
    const session = await getServerSession()
    if (!session?.sub) {
      log.warn("Unauthorized access attempt")
      throw ErrorFactories.authNoSession()
    }

    // Get user ID from database using cognito sub
    const userResult = await executeSQL(`
      SELECT id FROM users WHERE cognito_sub = :cognitoSub
    `, [{ name: 'cognitoSub', value: { stringValue: session.sub } }])

    if (!userResult || userResult.length === 0) {
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    // SECURITY FIX: Use safe parsing for user ID from database result
    const userIdRaw = userResult[0].id
    if (typeof userIdRaw !== 'number' && typeof userIdRaw !== 'string') {
      throw ErrorFactories.invalidInput("userId", userIdRaw, "invalid user ID format from database")
    }

    const userId = Number(userIdRaw)
    if (!Number.isInteger(userId) || userId <= 0) {
      throw ErrorFactories.invalidInput("userId", userIdRaw, "must be a positive integer")
    }

    // Get execution result with all related data - includes access control check
    const sql = `
      SELECT
        er.id,
        er.scheduled_execution_id,
        er.result_data,
        er.status,
        er.executed_at,
        er.execution_duration_ms,
        er.error_message,
        se.name as schedule_name,
        se.user_id,
        aa.name as assistant_architect_name
      FROM execution_results er
      JOIN scheduled_executions se ON er.scheduled_execution_id = se.id
      JOIN assistant_architects aa ON se.assistant_architect_id = aa.id
      WHERE er.id = :result_id AND se.user_id = :user_id
    `

    const parameters: SqlParameter[] = [
      { name: 'result_id', value: { longValue: resultId } },
      { name: 'user_id', value: { longValue: userId } }
    ]

    const results = await executeSQL(sql, parameters)

    if (!results || results.length === 0) {
      log.warn("Execution result not found or access denied", { resultId, userId })
      return NextResponse.json(
        { error: "Execution result not found" },
        { status: 404 }
      )
    }

    // Transform the result
    const rawResult = transformSnakeToCamel<Record<string, unknown>>(results[0])

    const executionResult: ExecutionResult = {
      id: Number(rawResult.id),
      scheduledExecutionId: Number(rawResult.scheduledExecutionId),
      resultData: (() => {
        try {
          return typeof rawResult.resultData === 'string'
            ? JSON.parse(rawResult.resultData)
            : rawResult.resultData || {};
        } catch (error) {
          log.warn('Invalid JSON in resultData', {
            resultId: rawResult.id,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          return {};
        }
      })(),
      status: String(rawResult.status) as 'success' | 'failed' | 'running',
      executedAt: rawResult.executedAt ? new Date(String(rawResult.executedAt) + ' UTC').toISOString() : '',
      executionDurationMs: Number(rawResult.executionDurationMs),
      errorMessage: rawResult.errorMessage ? String(rawResult.errorMessage) : null,
      scheduleName: String(rawResult.scheduleName),
      userId: Number(rawResult.userId),
      assistantArchitectName: String(rawResult.assistantArchitectName)
    }

    timer({ status: "success" })
    log.info("Execution result fetched successfully", { resultId })

    return NextResponse.json(executionResult)

  } catch (error) {
    timer({ status: "error" })

    log.error("Failed to fetch execution result", {
      error: error instanceof Error ? error.message : 'Unknown error',
      resultId: sanitizeForLogging((await params).id),
      stack: error instanceof Error ? error.stack : undefined
    })

    // Determine appropriate error status and message based on error type
    if (error && typeof error === 'object' && 'name' in error) {
      switch (error.name) {
        case 'InvalidInputError':
          return NextResponse.json(
            { error: "Invalid execution result ID" },
            { status: 400 }
          )
        case 'AuthNoSessionError':
          return NextResponse.json(
            { error: "Authentication required" },
            { status: 401 }
          )
        case 'DbRecordNotFoundError':
          return NextResponse.json(
            { error: "Execution result not found" },
            { status: 404 }
          )
        default:
          return NextResponse.json(
            { error: "Unable to fetch execution result" },
            { status: 500 }
          )
      }
    }

    return NextResponse.json(
      { error: "Unable to fetch execution result" },
      { status: 500 }
    )
  }
}

async function deleteHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId()
  const timer = startTimer("DELETE /api/execution-results/[id]")
  const log = createLogger({ requestId, endpoint: "DELETE /api/execution-results/[id]" })

  try {
    const { id } = await params
    log.info("Deleting execution result", { resultId: sanitizeForLogging(id) })

    // Validate ID parameter
    const resultId = Number.parseInt(id, 10)
    if (!Number.isInteger(resultId) || resultId <= 0) {
      throw ErrorFactories.invalidInput("id", id, "must be a positive integer")
    }

    // Auth check
    const session = await getServerSession()
    if (!session?.sub) {
      log.warn("Unauthorized delete attempt")
      throw ErrorFactories.authNoSession()
    }

    // Get user ID from database using cognito sub
    const userResult = await executeSQL(`
      SELECT id FROM users WHERE cognito_sub = :cognitoSub
    `, [{ name: 'cognitoSub', value: { stringValue: session.sub } }])

    if (!userResult || userResult.length === 0) {
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    // SECURITY FIX: Use safe parsing for user ID from database result
    const userIdRaw = userResult[0].id
    if (typeof userIdRaw !== 'number' && typeof userIdRaw !== 'string') {
      throw ErrorFactories.invalidInput("userId", userIdRaw, "invalid user ID format from database")
    }

    const userId = Number(userIdRaw)
    if (!Number.isInteger(userId) || userId <= 0) {
      throw ErrorFactories.invalidInput("userId", userIdRaw, "must be a positive integer")
    }

    // First check if the execution result exists and belongs to the user
    const checkSql = `
      SELECT er.id
      FROM execution_results er
      JOIN scheduled_executions se ON er.scheduled_execution_id = se.id
      WHERE er.id = :result_id AND se.user_id = :user_id
    `

    const checkParameters: SqlParameter[] = [
      { name: 'result_id', value: { longValue: resultId } },
      { name: 'user_id', value: { longValue: userId } }
    ]

    const checkResults = await executeSQL(checkSql, checkParameters)

    if (!checkResults || checkResults.length === 0) {
      log.warn("Execution result not found or access denied for deletion", { resultId, userId })
      return NextResponse.json(
        { error: "Execution result not found" },
        { status: 404 }
      )
    }

    // Delete the execution result
    const deleteSql = `
      DELETE FROM execution_results
      WHERE id = :result_id
    `

    const deleteParameters: SqlParameter[] = [
      { name: 'result_id', value: { longValue: resultId } }
    ]

    await executeSQL(deleteSql, deleteParameters)

    timer({ status: "success" })
    log.info("Execution result deleted successfully", { resultId, userId })

    return NextResponse.json({ success: true })

  } catch (error) {
    timer({ status: "error" })

    log.error("Failed to delete execution result", {
      error: error instanceof Error ? error.message : 'Unknown error',
      resultId: sanitizeForLogging((await params).id),
      stack: error instanceof Error ? error.stack : undefined
    })

    // Determine appropriate error status and message based on error type
    if (error && typeof error === 'object' && 'name' in error) {
      switch (error.name) {
        case 'InvalidInputError':
          return NextResponse.json(
            { error: "Invalid execution result ID" },
            { status: 400 }
          )
        case 'AuthNoSessionError':
          return NextResponse.json(
            { error: "Authentication required" },
            { status: 401 }
          )
        case 'DbRecordNotFoundError':
          return NextResponse.json(
            { error: "Execution result not found" },
            { status: 404 }
          )
        default:
          return NextResponse.json(
            { error: "Unable to delete execution result" },
            { status: 500 }
          )
      }
    }

    return NextResponse.json(
      { error: "Unable to delete execution result" },
      { status: 500 }
    )
  }
}

export { getHandler as GET, deleteHandler as DELETE }