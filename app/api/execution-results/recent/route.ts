import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { getRecentExecutionResults, getUserIdByCognitoSub } from "@/lib/db/drizzle"
import type { ExecutionResult } from "@/types/notifications"

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
    const userIdString = await getUserIdByCognitoSub(session.sub)

    if (!userIdString) {
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    const userId = Number(userIdString)
    log.info("Fetching recent execution results for user", { userId: sanitizeForLogging(userId) })

    // Get query parameters
    const url = new URL(request.url)
    const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '20'), 50)
    const statusParam = url.searchParams.get('status')
    const status = statusParam && ['success', 'failed', 'running'].includes(statusParam)
      ? (statusParam as 'success' | 'failed' | 'running')
      : undefined

    // Get execution results using Drizzle
    const results = await getRecentExecutionResults(userId, { limit, status })

    // Transform and structure the data
    const executionResults: ExecutionResult[] = results.map((row) => {
      return {
        id: row.id,
        scheduledExecutionId: row.scheduledExecutionId,
        resultData: row.resultData || {},
        status: row.status as 'success' | 'failed' | 'running',
        executedAt: row.executedAt?.toISOString() || '',
        executionDurationMs: row.executionDurationMs || 0,
        errorMessage: row.errorMessage || null,
        scheduleName: row.scheduleName,
        userId: row.userId,
        assistantArchitectName: row.assistantArchitectName
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