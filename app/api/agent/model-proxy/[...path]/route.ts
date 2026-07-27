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
  // OBSERVE-ONLY (2026-07-27, Hagel). Admission still MEASURES every call so
  // we accumulate real consumption data, but it must never reject a user's
  // request. The limits added in #1353 were calibrated as if one model call
  // per turn; an agentic turn makes many, each re-sending the whole context,
  // so a single conversation could exhaust the hourly cap and the agent
  // answered "I couldn't complete that" with nothing explaining why.
  //
  // We do not yet know what normal consumption looks like for this workload.
  // Until we do, over-limit is a LOG LINE, not a 429 — the numbers are here
  // to be read, and limits can be set from evidence later.
  if (!callAdmission.allowed && !isCapacityDenial(callAdmission)) {
    // `duplicate` = replayed idempotency key, not a budget. Still refused.
    return NextResponse.json({ error: "Duplicate model request" }, { status: 409 })
  }
  if (!callAdmission.allowed) {
    log.warn(
      "Model call rate over threshold (observe-only — request allowed)",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        reason: callAdmission.reason,
        limit: "MODEL_PROXY_CALL_LIMITS",
      }),
    )
  }

  let body: Uint8Array
  try {
    body = await readBoundedModelRequest(request)
  } catch (error) {
    if (callAdmission.allowed) await releaseResourceAdmission(callAdmission.leaseId)
    if (error instanceof ModelRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
  let parsed: ModelRequest
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as ModelRequest
  } catch {
    if (callAdmission.allowed) await releaseResourceAdmission(callAdmission.leaseId)
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
    if (callAdmission.allowed) await releaseResourceAdmission(callAdmission.leaseId)
    return NextResponse.json({ error: "Model or output limit is not allowed" }, { status: 400 })
  }
  // UTF-8 bytes are a conservative upper bound on input tokens. Admission uses
  // the entire trusted request body, including JSON syntax, so no model-bearing
  // string can escape accounting by changing the request shape.
  const inputTokenUpperBound = body.byteLength
  if (inputTokenUpperBound > MAX_INPUT_TOKEN_UPPER_BOUND) {
    if (callAdmission.allowed) await releaseResourceAdmission(callAdmission.leaseId)
    return NextResponse.json(
      { error: "Model input exceeds the supported context budget" },
      { status: 413 },
    )
  }
  // Forward the RE-SERIALIZED, validated object rather than the raw bytes,
  // with `anthropic_version` supplied when the client omitted it. An explicit
  // client value is preserved rather than overwritten.
  //
  // Re-serializing also closes a validate-vs-forward gap: the checks above run
  // on `parsed`, so forwarding the original bytes would let any parser
  // disagreement (duplicate keys, for instance, where JSON.parse keeps the
  // last and another parser may keep the first) send upstream something other
  // than what was actually validated.
  const forwardBody = new TextEncoder().encode(
    JSON.stringify(
      parsed.anthropic_version === undefined
        ? { ...parsed, anthropic_version: BEDROCK_ANTHROPIC_VERSION }
        : parsed,
    ),
  )

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
  // Measured unconditionally — previously cost was only sampled when tokens
  // were under limit, which blinded us to spend in exactly the situation
  // worth observing.
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
    if (callAdmission.allowed) await releaseResourceAdmission(callAdmission.leaseId)
    if (tokenAdmission.allowed) await releaseResourceAdmission(tokenAdmission.leaseId)
    return NextResponse.json({ error: "Duplicate model request" }, { status: 409 })
  }
  if (!tokenAdmission.allowed || !costAdmission.allowed) {
    // OBSERVE-ONLY — see the note above. Log the numbers; serve the request.
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

  // Only granted leases can be released or settled; a denied admission has no
  // leaseId. Collecting them here keeps the lifecycle correct now that a
  // denial no longer short-circuits the request.
  const activeLeaseIds = [callAdmission, tokenAdmission, costAdmission]
    .filter((a) => a.allowed)
    .map((a) => a.leaseId)

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
