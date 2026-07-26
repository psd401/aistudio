import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { executeQuery } from "@/lib/db/drizzle-client"
import {
  agentFailures,
  type AgentFailureContext,
  type AgentFailureSeverity,
  type AgentFailureSource,
} from "@/lib/db/schema"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"

const log = createLogger({ module: "agent-failure-broker" })
const SOURCES = new Set<AgentFailureSource>([
  "agent_self_report",
  "harness",
  "tool",
])
const SEVERITIES = new Set<AgentFailureSeverity>([
  "empty_response",
  "error",
  "warn",
])

function optionalString(
  value: unknown,
  maxLength: number
): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || value.length > maxLength) return undefined
  return value
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const invocation = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  })
  if (!invocation) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid failure report" }, { status: 400 })
  }
  const body = raw as Record<string, unknown>
  if (["ownerEmail", "userEmail", "userId"].some((field) => field in body)) {
    return NextResponse.json({ error: "Owner selectors are not accepted" }, { status: 400 })
  }
  if (
    typeof body.source !== "string" ||
    !SOURCES.has(body.source as AgentFailureSource) ||
    typeof body.severity !== "string" ||
    !SEVERITIES.has(body.severity as AgentFailureSeverity)
  ) {
    return NextResponse.json({ error: "Invalid failure type" }, { status: 400 })
  }
  const errorClass = optionalString(body.errorClass, 128)
  const errorMessage = optionalString(body.errorMessage, 4_000)
  const stackExcerpt = optionalString(body.stackExcerpt, 4_000)
  const model = optionalString(body.model, 128)
  const scheduleName = optionalString(body.scheduleName, 255)
  if (
    errorClass === undefined ||
    errorMessage === undefined ||
    stackExcerpt === undefined ||
    model === undefined ||
    scheduleName === undefined
  ) {
    return NextResponse.json({ error: "Failure field is too large" }, { status: 400 })
  }
  let context: AgentFailureContext | null = null
  if (body.context !== undefined && body.context !== null) {
    if (
      typeof body.context !== "object" ||
      Array.isArray(body.context) ||
      JSON.stringify(body.context).length > 8_000
    ) {
      return NextResponse.json({ error: "Invalid failure context" }, { status: 400 })
    }
    context = body.context as AgentFailureContext
  }

  try {
    const [created] = await executeQuery(
      (db) =>
        db
          .insert(agentFailures)
          .values({
            source: body.source as AgentFailureSource,
            severity: body.severity as AgentFailureSeverity,
            userId: invocation.ownerEmail,
            sessionId: invocation.sessionId,
            scheduleName,
            model,
            errorClass,
            errorMessage,
            stackExcerpt,
            context,
          })
          .returning({ id: agentFailures.id }),
      "agentFailureBrokerInsert"
    )
    log.warn(
      "Agent failure recorded",
      sanitizeForLogging({
        requestId,
        ownerEmail: invocation.ownerEmail,
        source: body.source,
        severity: body.severity,
        failureId: created?.id,
      })
    )
    return NextResponse.json({ logged: true, failureId: created?.id ?? null })
  } catch (error) {
    log.error(
      "Agent failure broker insert failed",
      sanitizeForLogging({
        requestId,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    return NextResponse.json({ error: "Failure record could not be stored" }, { status: 502 })
  }
}
