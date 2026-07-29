import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { executeOwnerAtriumOperation } from "@/lib/agent-workspace/atrium-owner-operation"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"

const log = createLogger({ module: "agent-atrium-broker" })
const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const ALLOWED_QUERY_KEYS = new Set([
  "kind",
  "status",
  "collection",
  "tag",
  "query",
  "since",
])
const IDENTIFIER = "[A-Za-z0-9%._~-]{1,384}"

type AtriumBody = {
  method: "GET" | "POST" | "PATCH" | "DELETE"
  path: string
  query?: Record<string, string>
  body?: Record<string, unknown>
}

const ALLOWED_PATHS: Record<AtriumBody["method"], readonly RegExp[]> = {
  GET: [
    /^$/,
    /^\/collections$/,
    new RegExp(`^/${IDENTIFIER}$`),
    // Committed markdown source — the ONLY way an agent can read a document's
    // body text (`GET /<id>` returns bodyLocation "proof" with no text).
    new RegExp(`^/${IDENTIFIER}/source$`),
    // Authored image assets (#1284): metadata list, plus a bounded
    // base64 byte read so an agent can copy an image between objects.
    new RegExp(`^/${IDENTIFIER}/assets$`),
    new RegExp(`^/${IDENTIFIER}/assets/${IDENTIFIER}/bytes$`),
  ],
  POST: [
    /^$/,
    /^\/collections$/,
    new RegExp(`^/${IDENTIFIER}/(?:versions|publish)$`),
    new RegExp(`^/${IDENTIFIER}/assets$`),
    new RegExp(`^/${IDENTIFIER}/assets/${IDENTIFIER}/complete$`),
  ],
  PATCH: [
    new RegExp(`^/${IDENTIFIER}(?:/visibility)?$`),
    new RegExp(`^/collections/${IDENTIFIER}$`),
  ],
  DELETE: [
    new RegExp(`^/${IDENTIFIER}$`),
    new RegExp(
      `^/${IDENTIFIER}/publish/(?:intranet|public_web|schoology|google)$`
    ),
  ],
}

function isAllowedMethodPath(method: string, path: string): boolean {
  const patterns = ALLOWED_PATHS[method as AtriumBody["method"]]
  return patterns?.some((pattern) => pattern.test(path)) ?? false
}

/** A non-null, non-array object — the shape both `query` and `body` must have. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * `query` is optional, but when present every key must be on the allowlist and
 * every value a bounded string. An unrecognized key is a rejection, not a
 * silently dropped field.
 */
function isAllowedQuery(value: unknown): boolean {
  if (value === undefined) return true
  if (!isPlainObject(value)) return false
  return Object.entries(value).every(
    ([key, item]) =>
      ALLOWED_QUERY_KEYS.has(key) &&
      typeof item === "string" &&
      item.length <= 512
  )
}

const ENVELOPE_KEYS = new Set(["method", "path", "query", "body"])

function parseBody(value: unknown): AtriumBody | null {
  if (!isPlainObject(value)) return null
  const raw = value
  if (Object.keys(raw).some((key) => !ENVELOPE_KEYS.has(key))) return null
  if (typeof raw.method !== "string" || typeof raw.path !== "string") return null
  if (!isAllowedMethodPath(raw.method, raw.path)) return null
  if (!isAllowedQuery(raw.query)) return null
  if (raw.body !== undefined && !isPlainObject(raw.body)) return null
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

  try {
    const result = await executeOwnerAtriumOperation({
      ownerEmail: context.ownerEmail,
      requestId,
      ...body,
    })
    log.info(
      "Owner-bound Atrium operation completed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        method: body.method,
        path: body.path,
        status: result.httpStatus,
      })
    )
    return NextResponse.json(result)
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
