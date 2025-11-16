import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { executeSQL } from "@/lib/db/data-api-adapter"
import { transformSnakeToCamel } from "@/lib/db/field-mapper"
import type { UserNotification } from "@/types/notifications"
import type { SqlParameter } from "@aws-sdk/client-rds-data"

export async function GET(request: NextRequest) {
  const requestId = generateRequestId()
  const timer = startTimer("GET /api/notifications")
  const log = createLogger({ requestId, endpoint: "GET /api/notifications" })

  try {
    log.info("Fetching user notifications")

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
    log.info("Fetching notifications for user", { userId: sanitizeForLogging(userId) })

    // Get query parameters
    const url = new URL(request.url)
    const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '50'), 100)
    const offset = Math.max(Number.parseInt(url.searchParams.get('offset') || '0'), 0)
    const type = url.searchParams.get('type') // 'email' | 'in_app' | null for all

    // Build SQL query with optional type filter
    let sql = `
      SELECT
        un.id,
        un.user_id,
        un.execution_result_id,
        un.type,
        un.status,
        un.delivery_attempts,
        un.last_attempt_at,
        un.failure_reason,
        un.created_at,
        er.id as result_id,
        er.scheduled_execution_id,
        er.result_data,
        er.status as result_status,
        er.executed_at,
        er.execution_duration_ms,
        er.error_message as result_error_message,
        se.name as schedule_name,
        aa.name as assistant_architect_name
      FROM user_notifications un
      LEFT JOIN execution_results er ON un.execution_result_id = er.id
      LEFT JOIN scheduled_executions se ON er.scheduled_execution_id = se.id
      LEFT JOIN assistant_architects aa ON se.assistant_architect_id = aa.id
      WHERE un.user_id = :user_id
    `

    const parameters: SqlParameter[] = [
      { name: 'user_id', value: { longValue: userId } }
    ]

    if (type && ['email', 'in_app'].includes(type)) {
      sql += ` AND un.type = :type`
      parameters.push({ name: 'type', value: { stringValue: type } })
    }

    sql += `
      ORDER BY un.created_at DESC
      LIMIT :limit OFFSET :offset
    `

    parameters.push(
      { name: 'limit', value: { longValue: limit } },
      { name: 'offset', value: { longValue: offset } }
    )

    const results = await executeSQL(sql, parameters)

    // Transform and structure the data
    const notifications: UserNotification[] = results.map((row: Record<string, unknown>) => {
      const notification = transformSnakeToCamel<Record<string, unknown>>(row)

      const baseNotification = {
        id: Number(notification.id),
        userId: Number(notification.userId),
        executionResultId: Number(notification.executionResultId),
        type: String(notification.type) as 'email' | 'in_app',
        status: String(notification.status) as 'sent' | 'delivered' | 'read' | 'failed',
        deliveryAttempts: Number(notification.deliveryAttempts),
        lastAttemptAt: notification.lastAttemptAt ? String(notification.lastAttemptAt) : null,
        failureReason: notification.failureReason ? String(notification.failureReason) : null,
        createdAt: String(notification.createdAt)
      }

      if (notification.resultId) {
        return {
          ...baseNotification,
          executionResult: {
            id: Number(notification.resultId),
            scheduledExecutionId: Number(notification.scheduledExecutionId),
            resultData: (() => {
              try {
                return typeof notification.resultData === 'string'
                  ? JSON.parse(notification.resultData)
                  : notification.resultData || {};
              } catch (error) {
                log.warn('Invalid JSON in resultData', {
                  resultId: notification.resultId,
                  error: error instanceof Error ? error.message : 'Unknown error'
                });
                return {};
              }
            })(),
            status: String(notification.resultStatus) as 'success' | 'failed' | 'running',
            executedAt: String(notification.executedAt),
            executionDurationMs: Number(notification.executionDurationMs),
            errorMessage: notification.resultErrorMessage ? String(notification.resultErrorMessage) : null,
            scheduleName: String(notification.scheduleName),
            userId: Number(notification.userId),
            assistantArchitectName: String(notification.assistantArchitectName)
          }
        }
      }

      return baseNotification
    })

    timer({ status: "success" })
    log.info("Notifications fetched successfully", {
      count: notifications.length,
      limit,
      offset
    })

    return NextResponse.json(createSuccess(notifications, "Notifications retrieved successfully"))

  } catch (error) {
    timer({ status: "error" })
    return NextResponse.json(
      handleError(error, "Failed to fetch notifications", {
        context: "GET /api/notifications",
        requestId,
        operation: "fetchNotifications"
      }),
      { status: 500 }
    )
  }
}