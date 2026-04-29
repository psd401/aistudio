import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { resolveUserId } from "@/lib/auth/resolve-user"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import type { TypedError } from "@/types/error-types"
import { getRecentExecutionResults } from "@/lib/db/drizzle"
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

    // Resolve user ID (auto-provisions if missing)
    const userId = await resolveUserId(session, requestId)
    log.info("Fetching recent execution results for user", { userId: sanitizeForLogging(userId) })

    // Get query parameters
    const url = new URL(request.url)
    const parsed = Number.parseInt(url.searchParams.get('limit') ?? '20', 10)
    const limit = Math.min(isNaN(parsed) || parsed <= 0 ? 20 : parsed, 50)
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
    // Use "code" in error to identify TypedErrors — consistent with error-utils.ts:414 pattern
    const rawCode = error instanceof Error && "code" in error
      ? (error as TypedError).statusCode ?? 500
      : 500
    const statusCode = Number.isInteger(rawCode) && rawCode >= 100 && rawCode <= 599
      ? rawCode
      : 500
    return NextResponse.json(
      handleError(error, "Failed to fetch recent execution results", {
        context: "GET /api/execution-results/recent",
        requestId,
        operation: "fetchRecentExecutionResults"
      }),
      { status: statusCode }
    )
  }
}
