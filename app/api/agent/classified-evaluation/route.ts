import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { getSecretJson } from "@/lib/agent-workspace/secrets-manager"
import {
  CLASSIFIED_EVALUATION_TOOLS,
  ClassifiedGatewayError,
  classifiedGatewayDependencies,
} from "@/lib/agent-services/classified-gateway"
import { SAFE_EMAIL_RE } from "@/lib/agent-workspace/validation"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"
import {
  acquireResourceAdmission,
  finishResourceAdmission,
} from "@/lib/resource-admission"

const log = createLogger({ module: "agent-classified-evaluation-broker" })
const MAX_REQUEST_BYTES = 256 * 1024
const CLASSIFIED_GATEWAY_LIMITS = {
  contextActive: 1,
  ownerActive: 2,
  globalActive: 24,
  contextHourlyUnits: 30,
  ownerHourlyUnits: 60,
  globalHourlyUnits: 1_000,
  leaseMs: 3 * 60 * 1000,
} as const
const RATING_VALUES = new Set([
  "Requires Improvement",
  "Fair",
  "Satisfactory",
  "Good",
  "Outstanding",
])

function environment(): string {
  return process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
}

function normalizeArgs(
  toolName: string,
  value: unknown,
  ownerEmail: string
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const args = value as Record<string, unknown>
  if (toolName === "get_classified_evaluation_schema") {
    return Object.keys(args).length === 0 ? {} : null
  }
  if (toolName === "list_supervised_employees") {
    if (
      Object.keys(args).some(
        (key) => key !== "evaluator_email"
      )
    ) {
      return null
    }
    return { evaluator_email: ownerEmail }
  }
  if (toolName !== "submit_classified_evaluation") return null

  const allowed = Object.keys(args).every(
    (key) =>
      key === "employee_email" ||
      key === "evaluator_email" ||
      key === "supervisor_comments" ||
      /^rating_[a-z0-9_]{1,64}$/.test(key)
  )
  if (
    !allowed ||
    typeof args.employee_email !== "string" ||
    !SAFE_EMAIL_RE.test(args.employee_email) ||
    (args.supervisor_comments !== undefined &&
      (typeof args.supervisor_comments !== "string" ||
        args.supervisor_comments.length > 20_000))
  ) {
    return null
  }
  const ratingEntries = Object.entries(args).filter(([key]) =>
    key.startsWith("rating_")
  )
  if (
    ratingEntries.length < 1 ||
    ratingEntries.length > 20 ||
    ratingEntries.some(
      ([, rating]) =>
        typeof rating !== "string" || !RATING_VALUES.has(rating)
    )
  ) {
    return null
  }
  return {
    ...args,
    employee_email: args.employee_email.toLowerCase(),
    evaluator_email: ownerEmail,
  }
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  })
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid gateway operation" }, { status: 400 })
  }
  const body = raw as Record<string, unknown>
  if (
    Object.keys(body).some(
      (key) => key !== "toolName" && key !== "arguments"
    ) ||
    typeof body.toolName !== "string" ||
    !CLASSIFIED_EVALUATION_TOOLS.has(body.toolName)
  ) {
    return NextResponse.json({ error: "Invalid gateway operation" }, { status: 400 })
  }
  const args = normalizeArgs(body.toolName, body.arguments, context.ownerEmail)
  if (!args) {
    return NextResponse.json({ error: "Invalid gateway arguments" }, { status: 400 })
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "Request is too large" }, { status: 413 })
  }

  const config = await getSecretJson<{ url?: unknown; token?: unknown }>(
    `psd-agent/${environment()}/agent-gateway`
  )
  if (
    typeof config?.url !== "string" ||
    !config.url ||
    typeof config.token !== "string" ||
    !config.token ||
    config.token.length > 8192
  ) {
    return NextResponse.json(
      { error: "Classified evaluation gateway is not configured" },
      { status: 503 }
    )
  }
  let gatewayUrl: URL
  try {
    gatewayUrl = new URL(config.url)
  } catch {
    return NextResponse.json(
      { error: "Classified evaluation gateway is misconfigured" },
      { status: 503 }
    )
  }
  if (
    gatewayUrl.protocol !== "https:" ||
    gatewayUrl.username ||
    gatewayUrl.password
  ) {
    return NextResponse.json(
      { error: "Classified evaluation gateway is misconfigured" },
      { status: 503 }
    )
  }

  const admission = await acquireResourceAdmission({
    kind: "classified-gateway-calls",
    ownerKey: context.ownerEmail,
    contextKey: `${context.sessionId}:${context.nonce}`,
    idempotencyKey: requestId,
    units: 1,
    limits: CLASSIFIED_GATEWAY_LIMITS,
  })
  // OBSERVE-ONLY (2026-07-27, Hagel): admission MEASURES but must never
  // reject a user's request. The #1353 limits were set without data on
  // what this workload actually consumes; over-threshold is telemetry
  // until real numbers say otherwise.
  if (!admission.allowed) {
    log.warn("Classified gateway over threshold (observe-only — request allowed)", {
      requestId,
      reason: admission.reason,
    })
  }
  // A denied admission carries no leaseId, so settlement is conditional now
  // that a denial no longer short-circuits the request.
  const admissionLeaseId = admission.allowed ? admission.leaseId : null

  try {
    const result = await classifiedGatewayDependencies.execute(
      { url: gatewayUrl.toString(), token: config.token },
      body.toolName,
      args,
      undefined,
      request.signal,
    )
    log.info(
      "Owner-bound classified evaluation operation completed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        toolName: body.toolName,
        isError: result.isError,
      })
    )
    return NextResponse.json(result)
  } catch (error) {
    log.warn(
      "Owner-bound classified evaluation operation failed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        toolName: body.toolName,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    if (error instanceof ClassifiedGatewayError && error.code === "tool") {
      return NextResponse.json(
        { error: "Gateway tool rejected the operation", detail: error.detail },
        { status: 422 }
      )
    }
    return NextResponse.json(
      { error: "Classified evaluation gateway failed" },
      { status: 502 }
    )
  } finally {
    try {
      if (admissionLeaseId) await finishResourceAdmission(admissionLeaseId)
    } catch (finishError) {
      log.error(
        "Classified gateway admission settlement failed",
        sanitizeForLogging({
          requestId,
          leaseId: admissionLeaseId,
          error:
            finishError instanceof Error
              ? finishError.message
              : String(finishError),
        }),
      )
    }
  }
}
