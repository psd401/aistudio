import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { getSecretString } from "@/lib/agent-workspace/secrets-manager"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"

const log = createLogger({ module: "agent-aistudio-broker" })
const ALLOWED_METHODS = new Set(["tools/list", "tools/call"])
const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const PERSONAL_KEY_NAME = "aistudio_personal_key"

function environment(): string {
  return process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
}

function mcpUrl(): URL {
  const raw = process.env.APP_BASE_URL
  if (!raw) throw new Error("APP_BASE_URL is not configured")
  const base = new URL(raw)
  const localHttp =
    base.protocol === "http:" &&
    (base.hostname === "localhost" || base.hostname === "127.0.0.1")
  if (base.protocol !== "https:" && !localHttp) {
    throw new Error("APP_BASE_URL must use HTTPS")
  }
  return new URL("/api/mcp", base)
}

function isValidBody(
  value: unknown
): value is { method: "tools/list" | "tools/call"; params: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  if (Object.keys(body).some((key) => key !== "method" && key !== "params")) {
    return false
  }
  if (typeof body.method !== "string" || !ALLOWED_METHODS.has(body.method)) {
    return false
  }
  if (!body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
    return false
  }
  if (body.method === "tools/call") {
    const params = body.params as Record<string, unknown>
    if (
      typeof params.name !== "string" ||
      !/^[a-z][a-z0-9_]{0,127}$/.test(params.name) ||
      !params.arguments ||
      typeof params.arguments !== "object" ||
      Array.isArray(params.arguments) ||
      Object.keys(params).some(
        (key) => key !== "name" && key !== "arguments"
      )
    ) {
      return false
    }
  }
  return true
}

async function resolveKey(
  ownerEmail: string
): Promise<{ key: string; source: "personal" | "shared" } | null> {
  const personal = await getSecretString(
    `psd-agent-creds/${environment()}/user/${ownerEmail}/${PERSONAL_KEY_NAME}`
  )
  if (personal) return { key: personal, source: "personal" }
  const shared = await getSecretString(
    `psd-agent/${environment()}/aistudio-mcp-api-key`
  )
  return shared ? { key: shared, source: "shared" } : null
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  })
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!isValidBody(body)) {
    return NextResponse.json({ error: "Invalid AI Studio operation" }, { status: 400 })
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "Request is too large" }, { status: 413 })
  }

  const credential = await resolveKey(context.ownerEmail)
  if (!credential) {
    return NextResponse.json(
      { error: "AI Studio credential is not configured" },
      { status: 404 }
    )
  }

  const rpcBody = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: body.method,
    params: body.params,
  }
  try {
    const upstream = await fetch(mcpUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential.key}`,
        "mcp-protocol-version": "2024-11-05",
      },
      body: JSON.stringify(rpcBody),
      redirect: "error",
      signal: AbortSignal.timeout(
        body.method === "tools/call" &&
          (body.params as { name?: unknown }).name === "execute_assistant"
          ? 910_000
          : 180_000
      ),
    })
    const text = await upstream.text()
    let payload: unknown = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }
    log.info(
      "Owner-bound AI Studio operation completed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        method: body.method,
        tool:
          body.method === "tools/call"
            ? (body.params as { name?: unknown }).name
            : undefined,
        status: upstream.status,
        keySource: credential.source,
      })
    )
    return NextResponse.json({
      httpStatus: upstream.status,
      payload,
      rawText: payload === null ? text.slice(0, 512) : undefined,
      keySource: credential.source,
    })
  } catch (error) {
    log.warn(
      "Owner-bound AI Studio operation failed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    return NextResponse.json({ error: "AI Studio operation failed" }, { status: 502 })
  }
}
