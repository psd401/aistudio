import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { executeSQL } from "@/lib/db/data-api-adapter"
import { transformSnakeToCamel } from "@/lib/db/field-mapper"
import type { ExecutionResult } from "@/types/notifications"
import type { SqlParameter } from "@aws-sdk/client-rds-data"

export async function GET(request: NextRequest) {
  const requestId = generateRequestId()
  const timer = startTimer("GET /api/execution-results/recent")
  const log = createLogger({ requestId, endpoint: "GET /api/execution-results/recent" })

  try {
    log.info("Fetching recent execution results")

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

    const userId = Number(userResult[0].id)
    log.info("Fetching recent execution results for user", { userId: sanitizeForLogging(userId) })

    // Get query parameters
    const url = new URL(request.url)
    const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '20'), 50)
    const status = url.searchParams.get('status') // 'success' | 'failed' | 'running' | null for all

    // Build SQL query with optional status filter
    let sql = `
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
      WHERE se.user_id = :user_id
    `

    const parameters: SqlParameter[] = [
      { name: 'user_id', value: { longValue: userId } }
    ]

    if (status && ['success', 'failed', 'running'].includes(status)) {
      sql += ` AND er.status = :status`
      parameters.push({ name: 'status', value: { stringValue: status } })
    }

    sql += `
      ORDER BY er.executed_at DESC
      LIMIT :limit
    `

    parameters.push({ name: 'limit', value: { longValue: limit } })

    const results = await executeSQL(sql, parameters)

    // Transform and structure the data
    const executionResults: ExecutionResult[] = results.map((row: Record<string, unknown>) => {
      const result = transformSnakeToCamel<Record<string, unknown>>(row)

      return {
        id: Number(result.id),
        scheduledExecutionId: Number(result.scheduledExecutionId),
        resultData: (() => {
          try {
            return typeof result.resultData === 'string'
              ? JSON.parse(result.resultData)
              : result.resultData || {};
          } catch (error) {
            log.warn('Invalid JSON in resultData', {
              resultId: result.id,
              error: error instanceof Error ? error.message : 'Unknown error'
            });
            return {};
          }
        })(),
        status: String(result.status) as 'success' | 'failed' | 'running',
        executedAt: result.executedAt ? new Date(result.executedAt + ' UTC').toISOString() : '',
        executionDurationMs: Number(result.executionDurationMs),
        errorMessage: result.errorMessage ? String(result.errorMessage) : null,
        scheduleName: String(result.scheduleName),
        userId: Number(result.userId),
        assistantArchitectName: String(result.assistantArchitectName)
      }
    })

    timer({ status: "success" })
    log.info("Recent execution results fetched successfully", {
      count: executionResults.length,
      limit
    })

    return NextResponse.json(createSuccess(executionResults, "Recent execution results retrieved successfully"))

  } catch (error) {
    timer({ status: "error" })
    return NextResponse.json(
      handleError(error, "Failed to fetch recent execution results", {
        context: "GET /api/execution-results/recent",
        requestId,
        operation: "fetchRecentExecutionResults"
      }),
      { status: 500 }
    )
  }
}