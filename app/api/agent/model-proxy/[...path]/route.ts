import { createHash } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { getSecretString } from "@/lib/agent-workspace/secrets-manager"
import {
  ModelRequestBodyError,
  readBoundedModelRequest,
} from "@/lib/agent-workspace/bounded-model-request"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"
import {
  acquireResourceAdmission,
  isCapacityDenial,
  finishResourceAdmission,
  releaseResourceAdmission,
} from "@/lib/resource-admission"

export const runtime = "nodejs"

const log = createLogger({ module: "agent-model-proxy" })
const UPSTREAM = "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages"
// Bedrock's Anthropic-compatible endpoint requires `anthropic_version` as a
// BODY field. The native Anthropic API instead takes an `anthropic-version`
// HEADER, which is what an Anthropic-Messages client sends — so a client that
// is correct against api.anthropic.com is rejected here with
// `{"type":"invalid_request_error","message":"anthropic_version: Field required"}`
// on EVERY call. The proxy forwards the body verbatim, so it has to supply the
// field itself.
const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31"
const ALLOWED_MODELS = new Set(["us.anthropic.claude-sonnet-5"])
const MAX_INPUT_TOKEN_UPPER_BOUND = 200_000
const MAX_OUTPUT_TOKENS = 32_768
const MODEL_PROXY_CALL_LIMITS = {
  contextActive: 1,
  ownerActive: 2,
  globalActive: 40,
  contextHourlyUnits: 60,
  ownerHourlyUnits: 120,
  globalHourlyUnits: 4_000,
  leaseMs: 5 * 60 * 1000,
} as const
const MODEL_PROXY_TOKEN_LIMITS = {
  contextActive: 2,
  ownerActive: 4,
  globalActive: 80,
  contextHourlyUnits: 2_000_000,
  ownerHourlyUnits: 1_000_000,
  globalHourlyUnits: 30_000_000,
  leaseMs: 5 * 60 * 1000,
} as const
const MODEL_PROXY_COST_LIMITS = {
  contextActive: 2,
  ownerActive: 4,
  globalActive: 80,
  contextHourlyUnits: 400_000_000,
  ownerHourlyUnits: 200_000_000,
  globalHourlyUnits: 5_000_000_000,
  leaseMs: 5 * 60 * 1000,
} as const
const SONNET_INPUT_COST_MICROCENTS_PER_TOKEN = 300
const SONNET_OUTPUT_COST_MICROCENTS_PER_TOKEN = 1_500

type ModelRequest = {
  anthropic_version?: unknown
  model?: unknown
  max_tokens?: unknown
}

type Admission = Awaited<ReturnType<typeof acquireResourceAdmission>>
type AgentContext = NonNullable<
  Awaited<ReturnType<typeof verifyAgentInvocationContext>>
>
type ValidatedModelRequest = ModelRequest & {
  model: string
  max_tokens: number
}

type PreparationResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: NextResponse }

interface BudgetAdmissionInput {
  context: AgentContext
  contextKey: string
  requestId: string
  callAdmission: Admission
  body: Uint8Array
  maxTokens: number
}

function releaseAdmission(admission: Admission): Promise<void> {
  return admission.allowed
    ? releaseResourceAdmission(admission.leaseId)
    : Promise.resolve()
}

async function acquireCallAdmission(
  context: AgentContext,
  contextKey: string,
  requestId: string,
): Promise<PreparationResult<Admission>> {
  const admission = await acquireResourceAdmission({
    kind: "model-proxy-call",
    ownerKey: context.ownerEmail,
    contextKey,
    idempotencyKey: `${context.nonce}:${requestId}`,
    units: 1,
    limits: MODEL_PROXY_CALL_LIMITS,
  })
  if (!admission.allowed && !isCapacityDenial(admission)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Duplicate model request" },
        { status: 409 },
      ),
    }
  }
  if (!admission.allowed) {
    log.warn(
      "Model call rate over threshold (observe-only — request allowed)",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        reason: admission.reason,
        limit: "MODEL_PROXY_CALL_LIMITS",
      }),
    )
  }
  return { ok: true, value: admission }
}

function isAllowedModelRequest(
  parsed: ModelRequest,
): parsed is ValidatedModelRequest {
  return (
    typeof parsed.model === "string" &&
    ALLOWED_MODELS.has(parsed.model) &&
    typeof parsed.max_tokens === "number" &&
    Number.isInteger(parsed.max_tokens) &&
    parsed.max_tokens >= 1 &&
    parsed.max_tokens <= MAX_OUTPUT_TOKENS
  )
}

async function prepareModelRequest(
  request: NextRequest,
  callAdmission: Admission,
): Promise<
  PreparationResult<{
    body: Uint8Array
    parsed: ValidatedModelRequest
    forwardBody: Uint8Array
  }>
> {
  let body: Uint8Array
  try {
    body = await readBoundedModelRequest(request)
  } catch (error) {
    await releaseAdmission(callAdmission)
    if (error instanceof ModelRequestBodyError) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: error.message },
          { status: error.status },
        ),
      }
    }
    throw error
  }
  let parsed: ModelRequest
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    ) as ModelRequest
  } catch {
    await releaseAdmission(callAdmission)
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Model request must be JSON" },
        { status: 400 },
      ),
    }
  }
  if (!isAllowedModelRequest(parsed)) {
    await releaseAdmission(callAdmission)
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Model or output limit is not allowed" },
        { status: 400 },
      ),
    }
  }
  if (body.byteLength > MAX_INPUT_TOKEN_UPPER_BOUND) {
    await releaseAdmission(callAdmission)
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Model input exceeds the supported context budget" },
        { status: 413 },
      ),
    }
  }
  const forwardBody = new TextEncoder().encode(
    JSON.stringify(
      parsed.anthropic_version === undefined
        ? { ...parsed, anthropic_version: BEDROCK_ANTHROPIC_VERSION }
        : parsed,
    ),
  )
  return { ok: true, value: { body, parsed, forwardBody } }
}

async function acquireTokenAndCostAdmissions({
  context,
  contextKey,
  requestId,
  callAdmission,
  body,
  maxTokens,
}: BudgetAdmissionInput): Promise<
  PreparationResult<{
    leaseIds: string[]
    reservedTokens: number
    reservedCostMicrocents: number
  }>
> {
  const bodyDigest = createHash("sha256").update(body).digest("hex")
  const reservedTokens = body.byteLength + maxTokens
  const reservedCostMicrocents =
    body.byteLength * SONNET_INPUT_COST_MICROCENTS_PER_TOKEN +
    maxTokens * SONNET_OUTPUT_COST_MICROCENTS_PER_TOKEN
  const tokenAdmission = await acquireResourceAdmission({
    kind: "model-proxy-total-tokens",
    ownerKey: context.ownerEmail,
    contextKey,
    idempotencyKey: `${context.nonce}:${bodyDigest}:tokens`,
    units: reservedTokens,
    limits: MODEL_PROXY_TOKEN_LIMITS,
  })
  const costAdmission = await acquireResourceAdmission({
    kind: "model-proxy-cost-microcents",
    ownerKey: context.ownerEmail,
    contextKey,
    idempotencyKey: `${context.nonce}:${bodyDigest}:cost`,
    units: reservedCostMicrocents,
    limits: MODEL_PROXY_COST_LIMITS,
  })
  if (
    (!tokenAdmission.allowed && !isCapacityDenial(tokenAdmission)) ||
    (!costAdmission.allowed && !isCapacityDenial(costAdmission))
  ) {
    await Promise.all([
      releaseAdmission(callAdmission),
      releaseAdmission(tokenAdmission),
    ])
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Duplicate model request" },
        { status: 409 },
      ),
    }
  }
  if (!tokenAdmission.allowed || !costAdmission.allowed) {
    log.warn(
      "Model token/cost over threshold (observe-only — request allowed)",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        reservedTokens,
        reservedCostMicrocents,
        tokenReason: tokenAdmission.allowed ? null : tokenAdmission.reason,
        costReason: costAdmission.allowed ? null : costAdmission.reason,
      }),
    )
  }
  return {
    ok: true,
    value: {
      leaseIds: [callAdmission, tokenAdmission, costAdmission]
        .filter((admission) => admission.allowed)
        .map((admission) => admission.leaseId),
      reservedTokens,
      reservedCostMicrocents,
    },
  }
}

function responseWithAdmissionLifecycle(
  upstream: Response,
  headers: Headers,
  leaseIds: readonly string[],
): Response {
  let finished = false
  const finish = async () => {
    if (finished) return
    finished = true
    await Promise.all(
      leaseIds.map((leaseId) => finishResourceAdmission(leaseId)),
    )
  }
  if (!upstream.body) {
    void finish()
    return new Response(null, { status: upstream.status, headers })
  }
  const reader = upstream.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          await finish()
          controller.close()
          return
        }
        if (value) controller.enqueue(value)
      } catch (error) {
        await finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      await finish()
    },
  })
  return new Response(body, { status: upstream.status, headers })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const requestId = generateRequestId()
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "consultation", "scheduled", "email-task"],
  })
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { path } = await params
  if (path.join("/") !== "anthropic/v1/messages") {
    return NextResponse.json({ error: "Unsupported model endpoint" }, { status: 404 })
  }
  const contextKey = `${context.sessionId}:${context.nonce}`
  const callResult = await acquireCallAdmission(context, contextKey, requestId)
  if (!callResult.ok) return callResult.response
  const callAdmission = callResult.value
  const prepared = await prepareModelRequest(request, callAdmission)
  if (!prepared.ok) return prepared.response
  const { body, parsed, forwardBody } = prepared.value
  const inputTokenUpperBound = body.byteLength
  const budgetResult = await acquireTokenAndCostAdmissions({
    context,
    contextKey,
    requestId,
    callAdmission,
    body,
    maxTokens: parsed.max_tokens,
  })
  if (!budgetResult.ok) return budgetResult.response
  const { leaseIds: activeLeaseIds } = budgetResult.value

  const secretId =
    process.env.AGENT_BEDROCK_API_KEY_SECRET_ID ||
    `psd-agent-bedrock-api-key-${process.env.ENVIRONMENT || "dev"}`
  const apiKey = await getSecretString(secretId)
  if (!apiKey) {
    log.error("Model broker credential is not configured", { requestId })
    await Promise.all(activeLeaseIds.map((id) => releaseResourceAdmission(id)))
    return NextResponse.json({ error: "Model broker is not configured" }, { status: 503 })
  }

  let upstream: Response
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: request.headers.get("accept") || "application/json",
        "x-api-key": apiKey,
      },
      body: Buffer.from(forwardBody),
      redirect: "error",
      signal: request.signal,
    })
  } catch (error) {
    // Once fetch has been dispatched, a transport error or caller abort is
    // ambiguous: the provider may already have accepted and billed the work.
    // Retain the conservative reservation instead of reopening quota.
    await Promise.all(activeLeaseIds.map((id) => finishResourceAdmission(id)))
    log.error(
      "Model broker upstream request failed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    return NextResponse.json({ error: "Model provider request failed" }, { status: 502 })
  }

  log.info(
    "Model broker request accepted",
    sanitizeForLogging({
      requestId,
      ownerEmail: context.ownerEmail,
      model: parsed.model,
      inputTokenUpperBound,
      maxTokens: parsed.max_tokens,
      upstreamStatus: upstream.status,
    })
  )
  const headers = new Headers()
  for (const name of [
    "content-type",
    "cache-control",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
  ]) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  return responseWithAdmissionLifecycle(upstream, headers, activeLeaseIds)
}
