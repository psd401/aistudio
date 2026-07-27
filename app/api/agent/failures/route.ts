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

interface FailureReport {
  source: AgentFailureSource
  severity: AgentFailureSeverity
  errorClass: string | null
  errorMessage: string | null
  stackExcerpt: string | null
  model: string | null
  scheduleName: string | null
  context: AgentFailureContext | null
}

function parseFailureContext(
  value: unknown
): { valid: true; context: AgentFailureContext | null } | { valid: false } {
  if (value === undefined || value === null) {
    return { valid: true, context: null }
  }
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(value).length > 8_000
  ) {
    return { valid: false }
  }
  return { valid: true, context: value as AgentFailureContext }
}

function hasValidFailureType(
  body: Record<string, unknown>
): body is Record<string, unknown> & {
  source: AgentFailureSource
  severity: AgentFailureSeverity
} {
  return (
    typeof body.source === "string" &&
    SOURCES.has(body.source as AgentFailureSource) &&
    typeof body.severity === "string" &&
    SEVERITIES.has(body.severity as AgentFailureSeverity)
  )
}

function parseFailureReport(
  raw: unknown
): { valid: true; report: FailureReport } | { valid: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, error: "Invalid failure report" }
  }
  const body = raw as Record<string, unknown>
  if (["ownerEmail", "userEmail", "userId"].some((field) => field in body)) {
    return { valid: false, error: "Owner selectors are not accepted" }
  }
  if (!hasValidFailureType(body)) {
    return { valid: false, error: "Invalid failure type" }
  }
  const optionalFields = {
    errorClass: optionalString(body.errorClass, 128),
    errorMessage: optionalString(body.errorMessage, 4_000),
    stackExcerpt: optionalString(body.stackExcerpt, 4_000),
    model: optionalString(body.model, 128),
    scheduleName: optionalString(body.scheduleName, 255),
  }
  if (Object.values(optionalFields).includes(undefined)) {
    return { valid: false, error: "Failure field is too large" }
  }
  const parsedContext = parseFailureContext(body.context)
  if (!parsedContext.valid) {
    return { valid: false, error: "Invalid failure context" }
  }
  return {
    valid: true,
    report: {
      source: body.source as AgentFailureSource,
      severity: body.severity as AgentFailureSeverity,
      errorClass: optionalFields.errorClass ?? null,
      errorMessage: optionalFields.errorMessage ?? null,
      stackExcerpt: optionalFields.stackExcerpt ?? null,
      model: optionalFields.model ?? null,
      scheduleName: optionalFields.scheduleName ?? null,
      context: parsedContext.context,
    },
  }
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
  const parsed = parseFailureReport(raw)
  if (!parsed.valid) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }
  const report = parsed.report

  try {
    const [created] = await executeQuery(
      (db) =>
        db
          .insert(agentFailures)
          .values({
            source: report.source,
            severity: report.severity,
            userId: invocation.ownerEmail,
            sessionId: invocation.sessionId,
            scheduleName: report.scheduleName,
            model: report.model,
            errorClass: report.errorClass,
            errorMessage: report.errorMessage,
            stackExcerpt: report.stackExcerpt,
            context: report.context,
          })
          .returning({ id: agentFailures.id }),
      "agentFailureBrokerInsert"
    )
    log.warn(
      "Agent failure recorded",
      sanitizeForLogging({
        requestId,
        ownerEmail: invocation.ownerEmail,
        source: report.source,
        severity: report.severity,
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
