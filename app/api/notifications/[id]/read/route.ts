import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { markNotificationAsRead, getUserIdByCognitoSub } from "@/lib/db/drizzle"


export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = generateRequestId()
  const timer = startTimer("PUT /api/notifications/[id]/read")
  const log = createLogger({ requestId, endpoint: "PUT /api/notifications/[id]/read" })

  try {
    const params = await context.params
    const notificationId = Number.parseInt(params.id)
    if (Number.isNaN(notificationId) || notificationId <= 0) {
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
    const userIdString = await getUserIdByCognitoSub(session.sub)

    if (!userIdString) {
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    const userId = Number(userIdString)

    // Verify notification belongs to user and update status
    const result = await markNotificationAsRead(notificationId, userId)

    if (!result) {
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