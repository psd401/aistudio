import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { getSecretString } from "@/lib/agent-workspace/secrets-manager"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"

export const runtime = "nodejs"

const log = createLogger({ module: "agent-model-proxy" })
const UPSTREAM = "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages"
const ALLOWED_MODELS = new Set(["us.anthropic.claude-sonnet-5"])
const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const MAX_OUTPUT_TOKENS = 32_768

type ModelRequest = {
  model?: unknown
  max_tokens?: unknown
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const requestId = generateRequestId()
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  })
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { path } = await params
  if (path.join("/") !== "anthropic/v1/messages") {
    return NextResponse.json({ error: "Unsupported model endpoint" }, { status: 404 })
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0")
  if (contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "Model request is too large" }, { status: 413 })
  }

  const body = await request.arrayBuffer()
  if (body.byteLength === 0 || body.byteLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "Invalid model request size" }, { status: 400 })
  }
  let parsed: ModelRequest
  try {
    parsed = JSON.parse(Buffer.from(body).toString("utf8")) as ModelRequest
  } catch {
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
    return NextResponse.json({ error: "Model or output limit is not allowed" }, { status: 400 })
  }

  const secretId =
    process.env.AGENT_BEDROCK_API_KEY_SECRET_ID ||
    `psd-agent-bedrock-api-key-${process.env.ENVIRONMENT || "dev"}`
  const apiKey = await getSecretString(secretId)
  if (!apiKey) {
    log.error("Model broker credential is not configured", { requestId })
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
      body,
      redirect: "error",
      signal: request.signal,
    })
  } catch (error) {
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
  return new Response(upstream.body, { status: upstream.status, headers })
}
