import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { ErrorFactories } from "@/lib/error-utils"
import { getExecutionResultById, getUserIdByCognitoSub, deleteExecutionResult } from "@/lib/db/drizzle"

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
    const userIdString = await getUserIdByCognitoSub(session.sub)

    if (!userIdString) {
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    const userId = Number(userIdString)
    if (!Number.isInteger(userId) || userId <= 0) {
      throw ErrorFactories.invalidInput("userId", userIdString, "must be a positive integer")
    }

    // Get execution result with all related data - includes access control check
    const result = await getExecutionResultById(resultId, userId)

    if (!result) {
      log.warn("Execution result not found or access denied", { resultId, userId })
      return NextResponse.json(
        { error: "Execution result not found" },
        { status: 404 }
      )
    }

    // Transform the result
    const executionResult: ExecutionResult = {
      id: result.id,
      scheduledExecutionId: result.scheduledExecutionId,
      resultData: result.resultData || {},
      status: result.status as 'success' | 'failed' | 'running',
      executedAt: result.executedAt?.toISOString() || '',
      executionDurationMs: result.executionDurationMs || 0,
      errorMessage: result.errorMessage || null,
      scheduleName: result.scheduleName,
      userId: result.userId,
      assistantArchitectName: result.assistantArchitectName
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
    const userIdString = await getUserIdByCognitoSub(session.sub)

    if (!userIdString) {
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    const userId = Number(userIdString)
    if (!Number.isInteger(userId) || userId <= 0) {
      throw ErrorFactories.invalidInput("userId", userIdString, "must be a positive integer")
    }

    // Delete the execution result with access control check
    const deleted = await deleteExecutionResult(resultId, userId)

    if (!deleted) {
      log.warn("Execution result not found or access denied for deletion", { resultId, userId })
      return NextResponse.json(
        { error: "Execution result not found" },
        { status: 404 }
      )
    }

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