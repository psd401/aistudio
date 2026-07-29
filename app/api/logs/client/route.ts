import { NextRequest, NextResponse } from "next/server"
import { createLogger, generateRequestId } from "@/lib/logger"
import { getServerSession } from "@/lib/auth/server-session"

// Rate limiting - in production use Redis
const requestCounts = new Map<string, { count: number; resetTime: number }>()
const RATE_LIMIT = 100 // Max 100 logs per minute per user
const RATE_WINDOW = 60 * 1000 // 1 minute

interface ClientLogEntry {
  level?: string
  message?: string
  component?: string
  hook?: string
  requestId?: string
  [key: string]: unknown
}

interface ClientLogPayload extends ClientLogEntry {
  batched?: boolean
  logs?: ClientLogEntry[]
  unload?: boolean
}

function rateLimitResponse(userId: string, now: number): NextResponse | null {
  const userLimit = requestCounts.get(userId)
  if (!userLimit || now >= userLimit.resetTime) {
    requestCounts.set(userId, { count: 1, resetTime: now + RATE_WINDOW })
    return null
  }
  if (userLimit.count >= RATE_LIMIT) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': '60' } }
    )
  }
  userLimit.count++
  return null
}

function maybeCleanupRequestCounts(now: number): void {
  if (Math.random() >= 0.01) return
  const cutoff = now - RATE_WINDOW * 2
  for (const [key, value] of requestCounts.entries()) {
    if (value.resetTime < cutoff) requestCounts.delete(key)
  }
}

function processClientLog(
  entry: ClientLogEntry,
  context: {
    requestId: string
    userId: string
    isBatched: boolean
    log: ReturnType<typeof createLogger>
  }
): void {
  try {
    const {
      level = 'info',
      message = 'Client log',
      component,
      hook,
      requestId: clientRequestId,
      ...meta
    } = entry
    const serverLog = createLogger({
      requestId: clientRequestId || context.requestId,
      source: 'client',
      component,
      hook,
      userId: context.userId,
      batched: context.isBatched
    })
    const formattedMessage = `[Client] ${message}`
    if (level === 'error') serverLog.error(formattedMessage, meta)
    else if (level === 'warn') serverLog.warn(formattedMessage, meta)
    else if (level === 'debug') serverLog.debug(formattedMessage, meta)
    else serverLog.info(formattedMessage, meta)
  } catch (error) {
    context.log.warn('Failed to process individual log entry', {
      error: error instanceof Error ? error.message : 'Unknown error',
      entry: JSON.stringify(entry).substring(0, 200)
    })
  }
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, endpoint: "POST /api/logs/client" })

  try {
    // Get session for user identification (optional - logs can work without auth)
    const session = await getServerSession()
    const userId = session?.sub || 'anonymous'

    const now = Date.now()
    const limitResponse = rateLimitResponse(userId, now)
    if (limitResponse) return limitResponse
    maybeCleanupRequestCounts(now)

    // Parse client log data
    const logData = (await request.json()) as ClientLogPayload

    // Handle both single logs and batched logs
    const logs = logData.batched ? logData.logs || [] : [logData]
    const isBatched = logData.batched || false
    const isUnload = logData.unload || false

    if (isBatched) {
      log.info('Processing batched client logs', {
        count: logs.length,
        userId,
        isUnload
      })
    }

    for (const entry of logs) {
      processClientLog(entry, { requestId, userId, isBatched, log })
    }

    return NextResponse.json({ success: true })

  } catch (error) {
    log.error('Failed to process client log', {
      error: error instanceof Error ? error.message : 'Unknown error'
    })

    return NextResponse.json(
      { error: 'Failed to process log' },
      { status: 500 }
    )
  }
}

// OPTIONS for CORS if needed
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}
