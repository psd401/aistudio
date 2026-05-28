/**
 * Agent Feedback Capture
 *
 * POST /api/agent/feedback
 * Auth: Bearer {shared-secret} from psd-agent/{env}/internal-api-key
 *
 * Records a thumbs-up / thumbs-down on a specific agent_messages row.
 * Called by the agent-router (or agent-cron) Lambda when a user clicks
 * a feedback button on a Chat card. UNIQUE(user_id, message_id) means
 * a second click for the same user+message updates the previous vote
 * via an ON CONFLICT DO UPDATE.
 *
 * The route itself is dumb — it doesn't validate the user actually saw
 * that message. The agent Lambda is the trust boundary: only it knows
 * the messageId for a given Chat card and authenticates with the shared
 * secret. Anyone with the shared secret can write any feedback row.
 */

import { NextRequest, NextResponse } from "next/server"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"
import { executeQuery } from "@/lib/db/drizzle-client"
import { sql } from "drizzle-orm"
import { agentFeedback } from "@/lib/db/schema/tables/agent-feedback"
import { getSecretString } from "@/lib/agent-workspace/secrets-manager"
import { timingSafeEqual } from "node:crypto"

const log = createLogger({ module: "agent-feedback" })

async function getExpectedSecret(): Promise<string | null> {
  const envVal = process.env.AGENT_INTERNAL_API_KEY
  if (envVal) return envVal
  const id = process.env.AGENT_INTERNAL_API_KEY_SECRET_ID
  if (!id) return null
  return getSecretString(id)
}

function authorized(req: NextRequest, expected: string): boolean {
  const header = req.headers.get("authorization") ?? ""
  const match = /^Bearer\s+(.+)$/.exec(header)
  if (!match) return false
  const presented = match[1].trim()
  const a = Buffer.from(presented, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

interface FeedbackBody {
  userId?: string
  messageId?: number
  thumbsUp?: boolean
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId()
  try {
    const expected = await getExpectedSecret()
    if (!expected) {
      log.error("AGENT_INTERNAL_API_KEY not configured", { requestId })
      return NextResponse.json(
        { error: "Feedback endpoint not configured" },
        { status: 503 },
      )
    }
    if (!authorized(req, expected)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = (await req.json().catch(() => null)) as FeedbackBody | null
    if (!body || !body.userId || typeof body.messageId !== "number" || typeof body.thumbsUp !== "boolean") {
      return NextResponse.json(
        { error: "Body must be { userId: string, messageId: number, thumbsUp: boolean }" },
        { status: 400 },
      )
    }

    await executeQuery(
      (db) =>
        db
          .insert(agentFeedback)
          .values({
            userId: body.userId!,
            messageId: body.messageId!,
            thumbsUp: body.thumbsUp!,
          })
          .onConflictDoUpdate({
            target: [agentFeedback.userId, agentFeedback.messageId],
            set: {
              thumbsUp: body.thumbsUp!,
              createdAt: sql`NOW()`,
            },
          }),
      "agentFeedback.insertOrUpdate",
    )

    log.info(
      "Feedback recorded",
      sanitizeForLogging({
        requestId,
        userId: body.userId,
        messageId: body.messageId,
        thumbsUp: body.thumbsUp,
      }),
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    log.error("Feedback write failed", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
