import { NextRequest, NextResponse } from "next/server"
import { getScheduleAction, updateScheduleAction, deleteScheduleAction } from "@/actions/db/schedule-actions"
import { getServerSession } from "@/lib/auth/server-session"
import { hasToolAccess } from "@/utils/roles"
import { createLogger, generateRequestId, startTimer } from '@/lib/logger'
export const dynamic = 'force-dynamic'

interface RouteParams {
  params: Promise<{
    id: string
  }>
}

/**
 * GET /api/schedules/[id] - Get single schedule
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const requestId = generateRequestId()
  const timer = startTimer("api.schedules.get")
  const log = createLogger({ requestId, route: "api.schedules.get" })

  const resolvedParams = await params
  const scheduleId = resolvedParams.id
  log.info("GET /api/schedules/[id] - Fetching schedule")

  try {
    const session = await getServerSession()
    if (!session || !session.sub) {
      log.warn("Unauthorized - No session or sub")
      timer({ status: "error", reason: "unauthorized" })
      return NextResponse.json(
        { isSuccess: false, message: "Unauthorized" },
        { status: 401, headers: { "X-Request-Id": requestId } }
      )
    }

    // Check if user has access to the assistant-architect tool
    const hasAccess = await hasToolAccess("assistant-architect")
    if (!hasAccess) {
      log.warn("Forbidden - User lacks assistant-architect access")
      timer({ status: "error", reason: "forbidden" })
      return NextResponse.json(
        { isSuccess: false, message: "Forbidden" },
        { status: 403, headers: { "X-Request-Id": requestId } }
      )
    }

    // Validate schedule ID with strict input validation
    if (!/^\d+$/.test(scheduleId)) {
      log.warn("Invalid schedule ID format")
      timer({ status: "error", reason: "invalid_id" })
      return NextResponse.json(
        { isSuccess: false, message: "Invalid schedule ID" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    const id = Number.parseInt(scheduleId, 10)
    if (id <= 0 || id > Number.MAX_SAFE_INTEGER) {
      log.warn("Schedule ID out of valid range")
      timer({ status: "error", reason: "invalid_id" })
      return NextResponse.json(
        { isSuccess: false, message: "Invalid schedule ID" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    // Note: Rate limiting handled by middleware if enabled

    const result = await getScheduleAction(id)

    if (!result.isSuccess) {
      log.warn("Failed to get schedule", { message: result.message })
      timer({ status: "error", reason: "fetch_failed" })

      // Return 404 for not found, 400 for other errors
      const statusCode = result.message.includes("not found") ? 404 : 400
      return NextResponse.json(result, {
        status: statusCode,
        headers: { "X-Request-Id": requestId }
      })
    }

    log.info("Schedule fetched successfully")
    timer({ status: "success" })

    return NextResponse.json(result.data, {
      headers: { "X-Request-Id": requestId }
    })
  } catch (error) {
    timer({ status: "error" })
    log.error("Error in get schedule API", error)
    return NextResponse.json(
      {
        isSuccess: false,
        message: "Failed to fetch schedule"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

/**
 * PUT /api/schedules/[id] - Update existing schedule
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const requestId = generateRequestId()
  const timer = startTimer("api.schedules.update")
  const log = createLogger({ requestId, route: "api.schedules.update" })

  const resolvedParams = await params
  const scheduleId = resolvedParams.id
  log.info("PUT /api/schedules/[id] - Updating schedule")

  try {
    const session = await getServerSession()
    if (!session || !session.sub) {
      log.warn("Unauthorized - No session or sub")
      timer({ status: "error", reason: "unauthorized" })
      return NextResponse.json(
        { isSuccess: false, message: "Unauthorized" },
        { status: 401, headers: { "X-Request-Id": requestId } }
      )
    }

    // Check if user has access to the assistant-architect tool
    const hasAccess = await hasToolAccess("assistant-architect")
    if (!hasAccess) {
      log.warn("Forbidden - User lacks assistant-architect access")
      timer({ status: "error", reason: "forbidden" })
      return NextResponse.json(
        { isSuccess: false, message: "Forbidden" },
        { status: 403, headers: { "X-Request-Id": requestId } }
      )
    }

    // Validate schedule ID with strict input validation
    if (!/^\d+$/.test(scheduleId)) {
      log.warn("Invalid schedule ID format")
      timer({ status: "error", reason: "invalid_id" })
      return NextResponse.json(
        { isSuccess: false, message: "Invalid schedule ID" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    const id = Number.parseInt(scheduleId, 10)
    if (id <= 0 || id > Number.MAX_SAFE_INTEGER) {
      log.warn("Schedule ID out of valid range")
      timer({ status: "error", reason: "invalid_id" })
      return NextResponse.json(
        { isSuccess: false, message: "Invalid schedule ID" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    // Note: Rate limiting handled by middleware if enabled

    // Parse request body
    let body
    try {
      body = await request.json()
    } catch {
      log.warn("Invalid JSON in request body")
      timer({ status: "error", reason: "invalid_json" })
      return NextResponse.json(
        { isSuccess: false, message: "Invalid JSON in request body" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    // Extract valid update fields
    const { name, assistantArchitectId, scheduleConfig, inputData, active } = body

    // At least one field must be provided
    if (name === undefined && assistantArchitectId === undefined &&
        scheduleConfig === undefined && inputData === undefined && active === undefined) {
      log.warn("No fields to update")
      timer({ status: "error", reason: "no_fields" })
      return NextResponse.json(
        { isSuccess: false, message: "At least one field must be provided for update" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    const updateData: Record<string, unknown> = {}
    if (name !== undefined) updateData.name = name
    if (assistantArchitectId !== undefined) updateData.assistantArchitectId = assistantArchitectId
    if (scheduleConfig !== undefined) updateData.scheduleConfig = scheduleConfig
    if (inputData !== undefined) updateData.inputData = inputData
    if (active !== undefined) updateData.active = active

    const result = await updateScheduleAction(id, updateData)

    if (!result.isSuccess) {
      log.warn("Failed to update schedule", { message: result.message })
      timer({ status: "error", reason: "update_failed" })

      // Return appropriate status code based on error type
      let statusCode = 400
      if (result.message.includes("not found")) {
        statusCode = 404
      } else if (result.message.includes("Unauthorized")) {
        statusCode = 401
      } else if (result.message.includes("Forbidden") || result.message.includes("access")) {
        statusCode = 403
      }

      return NextResponse.json(result, {
        status: statusCode,
        headers: { "X-Request-Id": requestId }
      })
    }

    log.info("Schedule updated successfully")
    timer({ status: "success" })

    return NextResponse.json(result.data, {
      headers: { "X-Request-Id": requestId }
    })
  } catch (error) {
    timer({ status: "error" })
    log.error("Error in update schedule API", error)
    return NextResponse.json(
      {
        isSuccess: false,
        message: "Failed to update schedule"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

/**
 * DELETE /api/schedules/[id] - Delete schedule
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const requestId = generateRequestId()
  const timer = startTimer("api.schedules.delete")
  const log = createLogger({ requestId, route: "api.schedules.delete" })

  const resolvedParams = await params
  const scheduleId = resolvedParams.id
  log.info("DELETE /api/schedules/[id] - Deleting schedule")

  try {
    const session = await getServerSession()
    if (!session || !session.sub) {
      log.warn("Unauthorized - No session or sub")
      timer({ status: "error", reason: "unauthorized" })
      return NextResponse.json(
        { isSuccess: false, message: "Unauthorized" },
        { status: 401, headers: { "X-Request-Id": requestId } }
      )
    }

    // Check if user has access to the assistant-architect tool
    const hasAccess = await hasToolAccess("assistant-architect")
    if (!hasAccess) {
      log.warn("Forbidden - User lacks assistant-architect access")
      timer({ status: "error", reason: "forbidden" })
      return NextResponse.json(
        { isSuccess: false, message: "Forbidden" },
        { status: 403, headers: { "X-Request-Id": requestId } }
      )
    }

    // Validate schedule ID with strict input validation
    if (!/^\d+$/.test(scheduleId)) {
      log.warn("Invalid schedule ID format")
      timer({ status: "error", reason: "invalid_id" })
      return NextResponse.json(
        { isSuccess: false, message: "Invalid schedule ID" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    const id = Number.parseInt(scheduleId, 10)
    if (id <= 0 || id > Number.MAX_SAFE_INTEGER) {
      log.warn("Schedule ID out of valid range")
      timer({ status: "error", reason: "invalid_id" })
      return NextResponse.json(
        { isSuccess: false, message: "Invalid schedule ID" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    // Note: Rate limiting handled by middleware if enabled

    const result = await deleteScheduleAction(id)

    if (!result.isSuccess) {
      log.warn("Failed to delete schedule", { message: result.message })
      timer({ status: "error", reason: "delete_failed" })

      // Return appropriate status code based on error type
      let statusCode = 400
      if (result.message.includes("not found")) {
        statusCode = 404
      } else if (result.message.includes("Unauthorized")) {
        statusCode = 401
      } else if (result.message.includes("Forbidden") || result.message.includes("access")) {
        statusCode = 403
      }

      return NextResponse.json(result, {
        status: statusCode,
        headers: { "X-Request-Id": requestId }
      })
    }

    log.info("Schedule deleted successfully")
    timer({ status: "success" })

    return NextResponse.json({
      success: true
    }, {
      headers: { "X-Request-Id": requestId }
    })
  } catch (error) {
    timer({ status: "error" })
    log.error("Error in delete schedule API", error)
    return NextResponse.json(
      {
        isSuccess: false,
        message: "Failed to delete schedule"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}