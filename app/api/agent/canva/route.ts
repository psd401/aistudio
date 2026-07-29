import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import {
  canvaSecretId,
  getSecretJson,
  storeCanvaRefreshToken,
  type CanvaTokenData,
} from "@/lib/agent-workspace/secrets-manager"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"

const log = createLogger({ module: "agent-canva-broker" })
const CANVA_API_BASE = "https://api.canva.com/rest"
const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token"
const MAX_REQUEST_BYTES = 26 * 1024 * 1024
const MAX_BINARY_BYTES = 25 * 1024 * 1024
const ALLOWED_QUERY_KEYS = new Set([
  "query",
  "ownership",
  "sort_by",
  "continuation",
])
const JOB_ID = "[A-Za-z0-9_-]{1,256}"

type CanvaStatusBody = { operation: "status" }
type CanvaRequestBody = {
  operation: "request"
  method: "GET" | "POST"
  path: string
  query?: Record<string, string>
  body?: Record<string, unknown>
  rawBodyBase64?: string
  uploadMetadata?: string
}
type CanvaBody = CanvaStatusBody | CanvaRequestBody

function environment(): string {
  return process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
}

function clientSecretId(): string {
  return `psd-agent/${environment()}/canva-oauth-client`
}

function isAllowedMethodPath(method: string, path: string): boolean {
  if (method === "GET") {
    return (
      path === "/v1/users/me" ||
      path === "/v1/users/me/profile" ||
      path === "/v1/designs" ||
      new RegExp(`^/v1/(?:exports|asset-uploads)/${JOB_ID}$`).test(path)
    )
  }
  return (
    method === "POST" &&
    (path === "/v1/designs" ||
      path === "/v1/exports" ||
      path === "/v1/asset-uploads")
  )
}

function validUploadMetadata(value: string): boolean {
  if (value.length > 4096) return false
  try {
    const parsed: unknown = JSON.parse(value)
    const metadata =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    const encoded =
      metadata && typeof metadata.name_base64 === "string"
        ? metadata.name_base64
        : null
    return (
      encoded !== null &&
      metadata !== null &&
      Object.keys(metadata).length === 1 &&
      encoded.length > 0 &&
      encoded.length <= 1024 &&
      Buffer.from(encoded, "base64").toString("base64") === encoded
    )
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isValidCanvaQuery(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  return Object.entries(value).every(
    ([key, item]) =>
      ALLOWED_QUERY_KEYS.has(key) &&
      typeof item === "string" &&
      item.length <= 2048
  )
}

function isValidCanvaJsonBody(value: unknown): boolean {
  return value === undefined || isRecord(value)
}

function isValidRawUpload(raw: Record<string, unknown>): boolean {
  if (raw.rawBodyBase64 === undefined) {
    return raw.uploadMetadata === undefined
  }
  return (
    typeof raw.rawBodyBase64 === "string" &&
    raw.path === "/v1/asset-uploads" &&
    raw.method === "POST" &&
    typeof raw.uploadMetadata === "string" &&
    validUploadMetadata(raw.uploadMetadata) &&
    raw.body === undefined
  )
}

function parseBody(value: unknown): CanvaBody | null {
  if (!isRecord(value)) return null
  const raw = value
  if (raw.operation === "status") {
    return Object.keys(raw).length === 1 ? { operation: "status" } : null
  }
  if (
    raw.operation !== "request" ||
    Object.keys(raw).some(
      (key) =>
        key !== "operation" &&
        key !== "method" &&
        key !== "path" &&
        key !== "query" &&
        key !== "body" &&
        key !== "rawBodyBase64" &&
        key !== "uploadMetadata"
    ) ||
    typeof raw.method !== "string" ||
    typeof raw.path !== "string" ||
    !isAllowedMethodPath(raw.method, raw.path) ||
    !isValidCanvaQuery(raw.query) ||
    !isValidCanvaJsonBody(raw.body) ||
    !isValidRawUpload(raw)
  ) {
    return null
  }
  return raw as CanvaRequestBody
}

async function clientCredentials(): Promise<{
  clientId: string
  clientSecret: string
} | null> {
  const value = await getSecretJson<{
    client_id?: unknown
    client_secret?: unknown
  }>(clientSecretId())
  if (
    typeof value?.client_id !== "string" ||
    !value.client_id ||
    value.client_id.startsWith("PLACEHOLDER") ||
    typeof value.client_secret !== "string" ||
    !value.client_secret ||
    value.client_secret.startsWith("PLACEHOLDER")
  ) {
    return null
  }
  return { clientId: value.client_id, clientSecret: value.client_secret }
}

async function refreshAccessToken(
  ownerEmail: string,
  record: CanvaTokenData
): Promise<{ accessToken: string } | null> {
  const credentials = await clientCredentials()
  if (!credentials || !record.refresh_token) return null
  const response = await fetch(CANVA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(
        `${credentials.clientId}:${credentials.clientSecret}`
      ).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: record.refresh_token,
    }).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  })
  const payload: unknown = await response.json().catch(() => null)
  if (
    !response.ok ||
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { access_token?: unknown }).access_token !== "string"
  ) {
    return null
  }
  const rotated = (payload as { refresh_token?: unknown }).refresh_token
  if (typeof rotated !== "string" || !rotated) return null
  await storeCanvaRefreshToken(ownerEmail, {
    refresh_token: rotated,
    scope:
      typeof (payload as { scope?: unknown }).scope === "string"
        ? (payload as { scope: string }).scope
        : record.scope,
    obtained_at: new Date().toISOString(),
  })
  return { accessToken: (payload as { access_token: string }).access_token }
}

function decodeUploadBody(
  body: CanvaRequestBody
): { valid: boolean; bytes?: Uint8Array<ArrayBuffer> } {
  if (body.rawBodyBase64 === undefined) return { valid: true }
  const decoded = Buffer.from(body.rawBodyBase64, "base64")
  const bytes = Uint8Array.from(decoded)
  return {
    valid:
      bytes.byteLength > 0 &&
      bytes.byteLength <= MAX_BINARY_BYTES &&
      decoded.toString("base64") === body.rawBodyBase64,
    bytes,
  }
}

function upstreamHeaders(
  accessToken: string,
  body: CanvaRequestBody,
  rawBytes: Uint8Array<ArrayBuffer> | undefined
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  }
  if (rawBytes) {
    headers["Content-Type"] = "application/octet-stream"
    headers["Asset-Upload-Metadata"] = body.uploadMetadata ?? ""
  } else if (body.body) {
    headers["Content-Type"] = "application/json"
  }
  return headers
}

async function forwardCanvaOperation(
  context: NonNullable<
    Awaited<ReturnType<typeof verifyAgentInvocationContext>>
  >,
  body: CanvaRequestBody,
  tokenRecord: CanvaTokenData,
  rawBytes: Uint8Array<ArrayBuffer> | undefined,
  requestId: string
): Promise<NextResponse> {
  try {
    const auth = await refreshAccessToken(context.ownerEmail, tokenRecord)
    if (!auth) {
      return NextResponse.json(
        { error: "Canva authorization is invalid or expired" },
        { status: 401 }
      )
    }
    const url = new URL(`${CANVA_API_BASE}${body.path}`)
    for (const [key, value] of Object.entries(body.query ?? {})) {
      url.searchParams.set(key, value)
    }
    const upstream = await fetch(url, {
      method: body.method,
      headers: upstreamHeaders(auth.accessToken, body, rawBytes),
      body: rawBytes ?? (body.body ? JSON.stringify(body.body) : undefined),
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
      "Owner-bound Canva operation completed",
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
      retryAfter: upstream.headers.get("Retry-After"),
    })
  } catch (error) {
    log.warn(
      "Owner-bound Canva operation failed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    return NextResponse.json({ error: "Canva operation failed" }, { status: 502 })
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
  const body = parseBody(raw)
  if (!body) {
    return NextResponse.json({ error: "Invalid Canva operation" }, { status: 400 })
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "Request is too large" }, { status: 413 })
  }

  const tokenRecord = await getSecretJson<CanvaTokenData>(
    canvaSecretId(context.ownerEmail)
  )
  if (body.operation === "status") {
    return NextResponse.json({ connected: Boolean(tokenRecord?.refresh_token) })
  }
  if (!tokenRecord?.refresh_token) {
    return NextResponse.json({ error: "Canva is not connected" }, { status: 401 })
  }

  const decoded = decodeUploadBody(body)
  if (!decoded.valid) {
    return NextResponse.json({ error: "Invalid upload body" }, { status: 400 })
  }
  return forwardCanvaOperation(
    context,
    body,
    tokenRecord,
    decoded.bytes,
    requestId
  )
}
