import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { executeSQL } from "@/lib/db/data-api-adapter"


export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = generateRequestId()
  const timer = startTimer("PUT /api/notifications/[id]/read")
  const log = createLogger({ requestId, endpoint: "PUT /api/notifications/[id]/read" })

  try {
    const params = await context.params
    const notificationId = Number.parseInt(params.id)
    if (isNaN(notificationId) || notificationId <= 0) {
      throw ErrorFactories.invalidInput("id", params.id, "Must be a positive integer")
    }

    log.info("Marking notification as read", { notificationId: sanitizeForLogging(notificationId) })

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

    // Verify notification belongs to user and update status
    const sql = `
      UPDATE user_notifications
      SET
        status = 'read',
        last_attempt_at = NOW()
      WHERE id = :notification_id
        AND user_id = :user_id
        AND status != 'read'
      RETURNING id, status
    `

    const parameters = [
      { name: 'notification_id', value: { longValue: notificationId } },
      { name: 'user_id', value: { longValue: userId } }
    ]

    const results = await executeSQL(sql, parameters)

    if (results.length === 0) {
      log.warn("Notification not found or already read", {
        notificationId: sanitizeForLogging(notificationId),
        userId: sanitizeForLogging(userId)
      })
      throw ErrorFactories.dbRecordNotFound("user_notifications", notificationId)
    }

    timer({ status: "success" })
    log.info("Notification marked as read successfully", {
      notificationId: sanitizeForLogging(notificationId)
    })

    return NextResponse.json(
      createSuccess({ id: notificationId, status: 'read' }, "Notification marked as read")
    )

  } catch (error) {
    timer({ status: "error" })
    return NextResponse.json(
      handleError(error, "Failed to mark notification as read", {
        context: "PUT /api/notifications/[id]/read",
        requestId,
        operation: "markNotificationRead",
      }),
      { status: error instanceof Error && error.message.includes('not found') ? 404 : 500 }
    )
  }
}