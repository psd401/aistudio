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
  finishResourceAdmission,
  releaseResourceAdmission,
} from "@/lib/resource-admission"

export const runtime = "nodejs"

const log = createLogger({ module: "agent-model-proxy" })
const UPSTREAM = "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages"
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
  model?: unknown
  max_tokens?: unknown
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
  const callAdmission = await acquireResourceAdmission({
    kind: "model-proxy-call",
    ownerKey: context.ownerEmail,
    contextKey,
    idempotencyKey: `${context.nonce}:${requestId}`,
    units: 1,
    limits: MODEL_PROXY_CALL_LIMITS,
  })
  if (!callAdmission.allowed) {
    return NextResponse.json(
      { error: "Model request capacity is exhausted" },
      { status: 429, headers: { "Retry-After": "60" } },
    )
  }

  let body: Uint8Array
  try {
    body = await readBoundedModelRequest(request)
  } catch (error) {
    await releaseResourceAdmission(callAdmission.leaseId)
    if (error instanceof ModelRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
  let parsed: ModelRequest
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as ModelRequest
  } catch {
    await releaseResourceAdmission(callAdmission.leaseId)
    return NextResponse.json({ error: "Model request must be JSON" }, { status: 400 })
  }
  if (
    typeof parsed.model !== "string" ||
    !ALLOWED_MODELS.has(parsed.model) ||
    typeof parsed.max_tokens !== "number" ||
    !Number.isInteger(parsed.max_tokens) ||
    parsed.max_tokens < 1 ||
    parsed.max_tokens > MAX_OUTPUT_TOKENS
  ) {
    await releaseResourceAdmission(callAdmission.leaseId)
    return NextResponse.json({ error: "Model or output limit is not allowed" }, { status: 400 })
  }
  // UTF-8 bytes are a conservative upper bound on input tokens. Admission uses
  // the entire trusted request body, including JSON syntax, so no model-bearing
  // string can escape accounting by changing the request shape.
  const inputTokenUpperBound = body.byteLength
  if (inputTokenUpperBound > MAX_INPUT_TOKEN_UPPER_BOUND) {
    await releaseResourceAdmission(callAdmission.leaseId)
    return NextResponse.json(
      { error: "Model input exceeds the supported context budget" },
      { status: 413 },
    )
  }
  const bodyDigest = createHash("sha256").update(body).digest("hex")
  const reservedTokens = inputTokenUpperBound + parsed.max_tokens
  const reservedCostMicrocents =
    inputTokenUpperBound * SONNET_INPUT_COST_MICROCENTS_PER_TOKEN +
    parsed.max_tokens * SONNET_OUTPUT_COST_MICROCENTS_PER_TOKEN

  const tokenAdmission = await acquireResourceAdmission({
    kind: "model-proxy-total-tokens",
    ownerKey: context.ownerEmail,
    contextKey,
    idempotencyKey: `${context.nonce}:${bodyDigest}:tokens`,
    units: reservedTokens,
    limits: MODEL_PROXY_TOKEN_LIMITS,
  })
  const costAdmission = tokenAdmission.allowed
    ? await acquireResourceAdmission({
        kind: "model-proxy-cost-microcents",
        ownerKey: context.ownerEmail,
        contextKey,
        idempotencyKey: `${context.nonce}:${bodyDigest}:cost`,
        units: reservedCostMicrocents,
        limits: MODEL_PROXY_COST_LIMITS,
      })
    : tokenAdmission
  if (!tokenAdmission.allowed || !costAdmission.allowed) {
    if (tokenAdmission.allowed) {
      await releaseResourceAdmission(tokenAdmission.leaseId)
    }
    await releaseResourceAdmission(callAdmission.leaseId)
    return NextResponse.json(
      { error: "Model token or cost budget is exhausted" },
      { status: 429, headers: { "Retry-After": "60" } },
    )
  }

  const secretId =
    process.env.AGENT_BEDROCK_API_KEY_SECRET_ID ||
    `psd-agent-bedrock-api-key-${process.env.ENVIRONMENT || "dev"}`
  const apiKey = await getSecretString(secretId)
  if (!apiKey) {
    log.error("Model broker credential is not configured", { requestId })
    await Promise.all([
      releaseResourceAdmission(callAdmission.leaseId),
      releaseResourceAdmission(tokenAdmission.leaseId),
      releaseResourceAdmission(costAdmission.leaseId),
    ])
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
      body: Buffer.from(body),
      redirect: "error",
      signal: request.signal,
    })
  } catch (error) {
    // Once fetch has been dispatched, a transport error or caller abort is
    // ambiguous: the provider may already have accepted and billed the work.
    // Retain the conservative reservation instead of reopening quota.
    await Promise.all([
      finishResourceAdmission(callAdmission.leaseId),
      finishResourceAdmission(tokenAdmission.leaseId),
      finishResourceAdmission(costAdmission.leaseId),
    ])
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
  return responseWithAdmissionLifecycle(upstream, headers, [
    callAdmission.leaseId,
    tokenAdmission.leaseId,
    costAdmission.leaseId,
  ])
}
