import { NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { markAllNotificationsAsRead, getUserIdByCognitoSub } from "@/lib/db/drizzle"

export async function PUT() {
  const requestId = generateRequestId()
  const timer = startTimer("PUT /api/notifications/read-all")
  const log = createLogger({ requestId, endpoint: "PUT /api/notifications/read-all" })

  try {
    log.info("Marking all notifications as read")

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
    log.info("Marking all notifications as read for user", { userId: sanitizeForLogging(userId) })

    // Update all unread notifications for the user
    const results = await markAllNotificationsAsRead(userId)
    const updatedCount = results.length

    timer({ status: "success" })
    log.info("All notifications marked as read successfully", {
      updatedCount,
      userId: sanitizeForLogging(userId)
    })

    return NextResponse.json(
      createSuccess(
        { updatedCount },
        `${updatedCount} notification${updatedCount !== 1 ? 's' : ''} marked as read`
      )
    )

  } catch (error) {
    timer({ status: "error" })
    return NextResponse.json(
      handleError(error, "Failed to mark all notifications as read", {
        context: "PUT /api/notifications/read-all",
        requestId,
        operation: "markAllNotificationsRead"
      }),
      { status: 500 }
    )
  }
}