import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { getSecretString } from "@/lib/agent-workspace/secrets-manager"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"

const log = createLogger({ module: "agent-atrium-broker" })
const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const ALLOWED_QUERY_KEYS = new Set([
  "kind",
  "status",
  "collection",
  "tag",
  "query",
])
const IDENTIFIER = "[A-Za-z0-9%._~-]{1,384}"

function environment(): string {
  return process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
}

function contentBaseUrl(): URL {
  const raw = process.env.APP_BASE_URL
  if (!raw) throw new Error("APP_BASE_URL is not configured")
  const base = new URL(raw)
  const localHttp =
    base.protocol === "http:" &&
    (base.hostname === "localhost" || base.hostname === "127.0.0.1")
  if (base.protocol !== "https:" && !localHttp) {
    throw new Error("APP_BASE_URL must use HTTPS")
  }
  return new URL("/api/v1/content", base)
}

type AtriumBody = {
  method: "GET" | "POST" | "PATCH" | "DELETE"
  path: string
  query?: Record<string, string>
  body?: Record<string, unknown>
}

function isAllowedMethodPath(method: string, path: string): boolean {
  if (method === "GET") {
    return path === "" || new RegExp(`^/${IDENTIFIER}$`).test(path)
  }
  if (method === "POST") {
    return (
      path === "" ||
      new RegExp(`^/${IDENTIFIER}/(?:versions|publish)$`).test(path)
    )
  }
  if (method === "PATCH") {
    return new RegExp(`^/${IDENTIFIER}(?:/visibility)?$`).test(path)
  }
  if (method === "DELETE") {
    return (
      new RegExp(`^/${IDENTIFIER}$`).test(path) ||
      new RegExp(
        `^/${IDENTIFIER}/publish/(?:intranet|public_web|schoology|google)$`
      ).test(path)
    )
  }
  return false
}

function parseBody(value: unknown): AtriumBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (
    Object.keys(raw).some(
      (key) =>
        key !== "method" &&
        key !== "path" &&
        key !== "query" &&
        key !== "body"
    ) ||
    typeof raw.method !== "string" ||
    typeof raw.path !== "string" ||
    !isAllowedMethodPath(raw.method, raw.path)
  ) {
    return null
  }
  if (
    raw.query !== undefined &&
    (!raw.query ||
      typeof raw.query !== "object" ||
      Array.isArray(raw.query) ||
      Object.entries(raw.query).some(
        ([key, item]) =>
          !ALLOWED_QUERY_KEYS.has(key) ||
          typeof item !== "string" ||
          item.length > 512
      ))
  ) {
    return null
  }
  if (
    raw.body !== undefined &&
    (!raw.body || typeof raw.body !== "object" || Array.isArray(raw.body))
  ) {
    return null
  }
  return raw as AtriumBody
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
  const body = parseBody(raw)
  if (!body) {
    return NextResponse.json({ error: "Invalid Atrium operation" }, { status: 400 })
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "Request is too large" }, { status: 413 })
  }

  const key = await getSecretString(
    `psd-agent/${environment()}/atrium-content-api-key`
  )
  if (!key) {
    return NextResponse.json(
      { error: "Atrium credential is not configured" },
      { status: 404 }
    )
  }

  const url = contentBaseUrl()
  url.pathname = `${url.pathname.replace(/\/$/, "")}${body.path}`
  for (const [name, value] of Object.entries(body.query ?? {})) {
    url.searchParams.set(name, value)
  }
  try {
    const upstream = await fetch(url, {
      method: body.method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body.body ? { "Content-Type": "application/json" } : {}),
      },
      body: body.body ? JSON.stringify(body.body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
    const text = await upstream.text()
    let payload: unknown = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }
    log.info(
      "Owner-bound Atrium operation completed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        method: body.method,
        path: body.path,
        status: upstream.status,
      })
    )
    return NextResponse.json({
      httpStatus: upstream.status,
      payload,
      rawText: payload === null ? text.slice(0, 512) : undefined,
    })
  } catch (error) {
    log.warn(
      "Owner-bound Atrium operation failed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    return NextResponse.json({ error: "Atrium operation failed" }, { status: 502 })
  }
}
