import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { getUserNotifications, getUserIdByCognitoSub } from "@/lib/db/drizzle"
import type { UserNotification } from "@/types/notifications"

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
    const userIdString = await getUserIdByCognitoSub(session.sub)

    if (!userIdString) {
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    const userId = Number(userIdString)
    log.info("Fetching notifications for user", { userId: sanitizeForLogging(userId) })

    // Get query parameters
    const url = new URL(request.url)
    const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '50'), 100)
    const offset = Math.max(Number.parseInt(url.searchParams.get('offset') || '0'), 0)
    const typeParam = url.searchParams.get('type')
    const type = typeParam && ['email', 'in_app'].includes(typeParam)
      ? (typeParam as 'email' | 'in_app')
      : undefined

    // Get notifications using Drizzle
    const results = await getUserNotifications(userId, { limit, offset, type })

    // Transform and structure the data
    const notifications: UserNotification[] = results.map((row) => {
      const baseNotification = {
        id: row.id,
        userId: row.userId,
        executionResultId: row.executionResultId,
        type: row.type as 'email' | 'in_app',
        status: row.status as 'sent' | 'delivered' | 'read' | 'failed',
        deliveryAttempts: row.deliveryAttempts || 0,
        lastAttemptAt: row.lastAttemptAt?.toISOString() || null,
        failureReason: row.failureReason || null,
        createdAt: row.createdAt?.toISOString() || new Date().toISOString()
      }

      if (row.resultId) {
        return {
          ...baseNotification,
          executionResult: {
            id: row.resultId,
            scheduledExecutionId: row.scheduledExecutionId!,
            resultData: row.resultData || {},
            status: row.resultStatus as 'success' | 'failed' | 'running',
            executedAt: row.executedAt?.toISOString() || '',
            executionDurationMs: row.executionDurationMs || 0,
            errorMessage: row.resultErrorMessage || null,
            scheduleName: row.scheduleName || '',
            userId: row.userId,
            assistantArchitectName: row.assistantArchitectName || ''
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