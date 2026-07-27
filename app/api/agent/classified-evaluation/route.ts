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
  isCapacityDenial,
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

function normalizeSchemaArgs(args: Record<string, unknown>): Record<string, unknown> | null {
  return Object.keys(args).length === 0 ? {} : null
}

function normalizeEmployeeListArgs(
  args: Record<string, unknown>,
  ownerEmail: string
): Record<string, unknown> | null {
  if (Object.keys(args).some((key) => key !== "evaluator_email")) return null
  return { evaluator_email: ownerEmail }
}

function normalizeSubmissionArgs(
  args: Record<string, unknown>,
  ownerEmail: string
): Record<string, unknown> | null {
  const allowed = Object.keys(args).every(
    (key) =>
      key === "employee_email" ||
      key === "evaluator_email" ||
      key === "supervisor_comments" ||
      /^rating_[a-z0-9_]{1,64}$/.test(key)
  )
  const validComments =
    args.supervisor_comments === undefined ||
    (typeof args.supervisor_comments === "string" &&
      args.supervisor_comments.length <= 20_000)
  if (
    !allowed ||
    typeof args.employee_email !== "string" ||
    !SAFE_EMAIL_RE.test(args.employee_email) ||
    !validComments
  ) {
    return null
  }

  const ratingEntries = Object.entries(args).filter(([key]) =>
    key.startsWith("rating_")
  )
  const invalidRating = ratingEntries.some(
    ([, rating]) =>
      typeof rating !== "string" || !RATING_VALUES.has(rating)
  )
  if (ratingEntries.length === 0 || ratingEntries.length > 20 || invalidRating) {
    return null
  }
  return {
    ...args,
    employee_email: args.employee_email.toLowerCase(),
    evaluator_email: ownerEmail,
  }
}

function normalizeArgs(
  toolName: string,
  value: unknown,
  ownerEmail: string
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const args = value as Record<string, unknown>
  if (toolName === "get_classified_evaluation_schema") {
    return normalizeSchemaArgs(args)
  }
  if (toolName === "list_supervised_employees") {
    return normalizeEmployeeListArgs(args, ownerEmail)
  }
  if (toolName !== "submit_classified_evaluation") return null
  return normalizeSubmissionArgs(args, ownerEmail)
}

type GatewayRequest = {
  body: Record<string, unknown>
  toolName: string
  args: Record<string, unknown>
}

async function readGatewayRequest(
  request: NextRequest,
  ownerEmail: string
): Promise<{ value: GatewayRequest } | { response: NextResponse }> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return {
      response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      response: NextResponse.json({ error: "Invalid gateway operation" }, { status: 400 }),
    }
  }

  const body = raw as Record<string, unknown>
  const hasUnknownField = Object.keys(body).some(
    (key) => key !== "toolName" && key !== "arguments"
  )
  if (
    hasUnknownField ||
    typeof body.toolName !== "string" ||
    !CLASSIFIED_EVALUATION_TOOLS.has(body.toolName)
  ) {
    return {
      response: NextResponse.json({ error: "Invalid gateway operation" }, { status: 400 }),
    }
  }
  const args = normalizeArgs(body.toolName, body.arguments, ownerEmail)
  if (!args) {
    return {
      response: NextResponse.json({ error: "Invalid gateway arguments" }, { status: 400 }),
    }
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_REQUEST_BYTES) {
    return {
      response: NextResponse.json({ error: "Request is too large" }, { status: 413 }),
    }
  }
  return { value: { body, toolName: body.toolName, args } }
}

async function loadGatewayConfig(): Promise<
  { value: { url: string; token: string } } | { response: NextResponse }
> {
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
    return {
      response: NextResponse.json(
        { error: "Classified evaluation gateway is not configured" },
        { status: 503 }
      ),
    }
  }

  let gatewayUrl: URL
  try {
    gatewayUrl = new URL(config.url)
  } catch {
    return {
      response: NextResponse.json(
        { error: "Classified evaluation gateway is misconfigured" },
        { status: 503 }
      ),
    }
  }
  if (
    gatewayUrl.protocol !== "https:" ||
    gatewayUrl.username ||
    gatewayUrl.password
  ) {
    return {
      response: NextResponse.json(
        { error: "Classified evaluation gateway is misconfigured" },
        { status: 503 }
      ),
    }
  }
  return { value: { url: gatewayUrl.toString(), token: config.token } }
}

async function acquireGatewayLease(
  ownerEmail: string,
  contextKey: string,
  requestId: string
): Promise<{ leaseId: string | null } | { response: NextResponse }> {
  const admission = await acquireResourceAdmission({
    kind: "classified-gateway-calls",
    ownerKey: ownerEmail,
    contextKey,
    idempotencyKey: requestId,
    units: 1,
    limits: CLASSIFIED_GATEWAY_LIMITS,
  })
  if (!admission.allowed && !isCapacityDenial(admission)) {
    return {
      response: NextResponse.json({ error: "Duplicate request" }, { status: 409 }),
    }
  }
  if (!admission.allowed) {
    log.warn("Classified gateway over threshold (observe-only — request allowed)", {
      requestId,
      reason: admission.reason,
    })
  }
  return { leaseId: admission.allowed ? admission.leaseId : null }
}

async function settleGatewayLease(leaseId: string | null, requestId: string): Promise<void> {
  if (!leaseId) return
  try {
    await finishResourceAdmission(leaseId)
  } catch (error) {
    log.error(
      "Classified gateway admission settlement failed",
      sanitizeForLogging({
        requestId,
        leaseId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

async function executeGatewayRequest(options: {
  config: { url: string; token: string }
  gatewayRequest: GatewayRequest
  ownerEmail: string
  requestId: string
  signal: AbortSignal
  leaseId: string | null
}): Promise<NextResponse> {
  const { config, gatewayRequest, ownerEmail, requestId, signal, leaseId } = options
  try {
    const result = await classifiedGatewayDependencies.execute(
      config,
      gatewayRequest.toolName,
      gatewayRequest.args,
      undefined,
      signal,
    )
    log.info(
      "Owner-bound classified evaluation operation completed",
      sanitizeForLogging({
        requestId,
        ownerEmail,
        toolName: gatewayRequest.toolName,
        isError: result.isError,
      })
    )
    return NextResponse.json(result)
  } catch (error) {
    log.warn(
      "Owner-bound classified evaluation operation failed",
      sanitizeForLogging({
        requestId,
        ownerEmail,
        toolName: gatewayRequest.toolName,
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
    await settleGatewayLease(leaseId, requestId)
  }
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  })
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const parsed = await readGatewayRequest(request, context.ownerEmail)
  if ("response" in parsed) return parsed.response
  const config = await loadGatewayConfig()
  if ("response" in config) return config.response
  const admission = await acquireGatewayLease(
    context.ownerEmail,
    `${context.sessionId}:${context.nonce}`,
    requestId
  )
  if ("response" in admission) return admission.response
  return executeGatewayRequest({
    config: config.value,
    gatewayRequest: parsed.value,
    ownerEmail: context.ownerEmail,
    requestId,
    signal: request.signal,
    leaseId: admission.leaseId,
  })
}
