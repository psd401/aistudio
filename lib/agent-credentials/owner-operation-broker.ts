import { AgentCredentialBroker } from "@/lib/agent-credentials/broker"
import { createLogger, sanitizeForLogging } from "@/lib/logger"

const MCP_PROTOCOL_VERSION = "2025-06-18"
const MAX_OPERATION_BYTES = 2 * 1024 * 1024
const MAX_TOKEN_RESPONSE_BYTES = 256 * 1024
const MAX_MCP_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_MCP_SSE_EVENTS = 2_000
const MAX_MCP_SSE_LINE_BYTES = 1024 * 1024
const MAX_PLAUD_ACCESS_TOKEN_BYTES = 16 * 1024
const MAX_PLAUD_SESSION_ID_BYTES = 1024
const MAX_RED_ROVER_DATE_SPAN_DAYS = 31
const MAX_RED_ROVER_VACANCY_ITEMS = 5_000
const MAX_RED_ROVER_SERIALIZED_BYTES = 8 * 1024 * 1024

type OperationResult =
  | { status: "ok"; result: unknown }
  | { status: "needs-auth"; reason: string }
  | { status: "forbidden"; detail: string }
  | { status: "rate-limited" }

const RED_ROVER_BASE_URL = "https://connect.redroverk12.com"
const log = createLogger({ module: "agent-owner-operation-broker" })

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 31 || code === 127
  })
}

function safeHttpsUrl(raw: string | undefined, fallback?: string): string {
  const value = raw || fallback
  if (!value) throw new Error("Owner operation endpoint is not configured")
  const url = new URL(value)
  if (url.protocol !== "https:") {
    throw new Error("Owner operation endpoint must use HTTPS")
  }
  return url.toString()
}

function boundedRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`)
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_OPERATION_BYTES) {
    throw new Error(`${name} is too large`)
  }
  return value
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  acceptedTypes: readonly string[]
): Promise<string> {
  const contentType = response.headers.get("content-type")?.toLowerCase() || ""
  if (
    acceptedTypes.length > 0 &&
    !acceptedTypes.some((type) => contentType.includes(type))
  ) {
    throw new Error("Owner operation upstream returned an invalid content type")
  }
  const rawLength = response.headers.get("content-length")
  if (rawLength) {
    const length = Number(rawLength)
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new Error("Owner operation upstream response is too large")
    }
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error("Owner operation upstream response is too large")
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined)
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  acceptedTypes: readonly string[] = ["application/json", "+json"]
): Promise<unknown> {
  const text = await readBoundedText(response, maxBytes, acceptedTypes)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error("Owner operation upstream returned invalid JSON")
  }
}

async function ownerCredentialJson(
  broker: AgentCredentialBroker,
  ownerEmail: string,
  name: string,
  sessionId: string
): Promise<Record<string, unknown> | null> {
  const credential = await broker.getUserOnly(ownerEmail, name, { sessionId })
  if (!credential) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(credential.value)
  } catch {
    throw new Error(`Owner ${name} credential is malformed`)
  }
  return boundedRecord(parsed, `Owner ${name} credential`)
}

export async function executePsdDataOperation(input: {
  ownerEmail: string
  sessionId: string
  method: unknown
  params: unknown
}): Promise<OperationResult> {
  if (input.method !== "tools/call" && input.method !== "tools/list") {
    throw new Error("Unsupported PSD data MCP method")
  }
  const params = boundedRecord(input.params ?? {}, "PSD data MCP params")
  const broker = new AgentCredentialBroker()
  const record = await ownerCredentialJson(
    broker,
    input.ownerEmail,
    "cognito-refresh",
    input.sessionId
  )
  const refreshToken = record?.refresh_token
  if (typeof refreshToken !== "string" || !refreshToken) {
    return { status: "needs-auth", reason: "owner credential is unavailable" }
  }
  const clientId =
    typeof record?.client_id === "string"
      ? record.client_id
      : process.env.AUTH_COGNITO_CLIENT_ID
  const region =
    typeof record?.region === "string"
      ? record.region
      : process.env.AUTH_COGNITO_REGION || process.env.AWS_REGION || "us-east-1"
  if (!clientId || !/^[a-z0-9-]+$/i.test(region)) {
    throw new Error("Cognito owner credential metadata is incomplete")
  }
  const refreshResponse = await fetch(
    `https://cognito-idp.${region}.amazonaws.com/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }
  )
  const refreshPayload = await readBoundedJson(
    refreshResponse,
    MAX_TOKEN_RESPONSE_BYTES,
    ["application/json", "+json", "application/x-amz-json-1.1"]
  )
  const authResult =
    isRecord(refreshPayload) && isRecord(refreshPayload.AuthenticationResult)
      ? refreshPayload.AuthenticationResult
      : null
  if (!refreshResponse.ok || typeof authResult?.IdToken !== "string") {
    return { status: "needs-auth", reason: "owner credential was rejected" }
  }

  const rpcResponse = await fetch(safeHttpsUrl(process.env.PSD_DATA_MCP_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authResult.IdToken}`,
      "X-Client-Model": "agentcore-owner-broker",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: input.method,
      params,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (rpcResponse.status === 401) {
    return { status: "needs-auth", reason: "PSD data rejected owner token" }
  }
  if (rpcResponse.status === 403) {
    return {
      status: "forbidden",
      detail: (
        await readBoundedText(rpcResponse, 4096, [
          "application/json",
          "text/plain",
        ])
      ).slice(0, 1024),
    }
  }
  if (rpcResponse.status === 429) return { status: "rate-limited" }
  if (!rpcResponse.ok) throw new Error(`PSD data MCP HTTP ${rpcResponse.status}`)
  const payload = await readBoundedJson(rpcResponse, MAX_MCP_RESPONSE_BYTES)
  if (!isRecord(payload)) throw new Error("PSD data MCP returned invalid JSON")
  if (payload.error !== undefined) return { status: "ok", result: payload }
  return { status: "ok", result: payload.result ?? null }
}

function parseMcpResponse(contentType: string, text: string, id: string): unknown {
  if (!contentType.includes("text/event-stream")) {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed) || parsed.id !== id) {
      throw new Error("Plaud MCP response did not match the request id")
    }
    return parsed
  }
  let eventCount = 0
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    eventCount += 1
    if (
      eventCount > MAX_MCP_SSE_EVENTS ||
      Buffer.byteLength(line, "utf8") > MAX_MCP_SSE_LINE_BYTES
    ) {
      throw new Error("Plaud MCP SSE response exceeds protocol limits")
    }
    const value = line.slice(5).trim()
    if (!value || value === "[DONE]") continue
    try {
      const parsed: unknown = JSON.parse(value)
      if (isRecord(parsed) && parsed.id === id) return parsed
    } catch {
      // Ignore SSE keepalives.
    }
  }
  throw new Error("Plaud MCP response did not match the request id")
}

function validatedPlaudHeader(
  value: string,
  name: string,
  maxBytes: number
): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    !/^[\x21-\x7E]+$/.test(value)
  ) {
    throw new Error(`Plaud ${name} is invalid`)
  }
  return value
}

async function plaudMcpRequest(
  accessToken: string,
  message: Record<string, unknown>,
  sessionId?: string,
  options: { allowEmpty?: boolean } = {}
): Promise<{ response: Response; payload: unknown }> {
  const safeAccessToken = validatedPlaudHeader(
    accessToken,
    "access token",
    MAX_PLAUD_ACCESS_TOKEN_BYTES
  )
  const safeSessionId = sessionId
    ? validatedPlaudHeader(
        sessionId,
        "session id",
        MAX_PLAUD_SESSION_ID_BYTES
      )
    : undefined
  const response = await fetch(
    safeHttpsUrl(process.env.PLAUD_MCP_URL, "https://mcp.plaud.ai/mcp"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${safeAccessToken}`,
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        ...(safeSessionId ? { "Mcp-Session-Id": safeSessionId } : {}),
      },
      body: JSON.stringify(message),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }
  )
  const contentType = response.headers.get("content-type") || ""
  const text = await readBoundedText(
    response,
    MAX_MCP_RESPONSE_BYTES,
    options.allowEmpty && response.status === 202
      ? []
      : ["application/json", "+json", "text/event-stream"]
  )
  return {
    response,
    payload:
      options.allowEmpty && !text
        ? null
        : parseMcpResponse(contentType, text, String(message.id ?? "")),
  }
}

export async function executePlaudOperation(input: {
  ownerEmail: string
  sessionId: string
  method: unknown
  toolName: unknown
  toolArgs: unknown
}): Promise<OperationResult> {
  const allowedTools = new Set([
    "get_current_user",
    "list_files",
    "get_file",
    "get_note",
    "get_transcript",
  ])
  if (input.method !== "tools/call" && input.method !== "tools/list") {
    throw new Error("Unsupported Plaud MCP method")
  }
  if (
    input.method === "tools/call" &&
    (typeof input.toolName !== "string" ||
      !allowedTools.has(input.toolName))
  ) {
    throw new Error("Unsupported Plaud tool")
  }
  const toolArgs = boundedRecord(input.toolArgs ?? {}, "Plaud tool arguments")
  const broker = new AgentCredentialBroker()
  const record = await ownerCredentialJson(
    broker,
    input.ownerEmail,
    "plaud",
    input.sessionId
  )
  const refreshToken = record?.refresh_token
  const clientId = record?.client_id
  if (
    typeof refreshToken !== "string" ||
    !refreshToken ||
    typeof clientId !== "string" ||
    !clientId
  ) {
    return { status: "needs-auth", reason: "owner credential is unavailable" }
  }
  const tokenResponse = await fetch(
    safeHttpsUrl(process.env.PLAUD_OAUTH_TOKEN_URL, "https://mcp.plaud.ai/token"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }
  )
  const tokenPayload = await readBoundedJson(
    tokenResponse,
    MAX_TOKEN_RESPONSE_BYTES
  )
  if (
    !tokenResponse.ok ||
    !isRecord(tokenPayload) ||
    typeof tokenPayload.access_token !== "string"
  ) {
    return { status: "needs-auth", reason: "owner credential was rejected" }
  }
  if (
    typeof tokenPayload.refresh_token === "string" &&
    tokenPayload.refresh_token !== refreshToken
  ) {
    try {
      await broker.put(
        input.ownerEmail,
        "plaud",
        JSON.stringify({
          ...record,
          refresh_token: tokenPayload.refresh_token,
          obtained_at: new Date().toISOString(),
        })
      )
    } catch (error) {
      log.warn(
        "Plaud refresh-token rotation persistence failed; current access continues",
        sanitizeForLogging({
          ownerEmail: input.ownerEmail,
          sessionId: input.sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      )
    }
  }

  const initializeId = crypto.randomUUID()
  const initialized = await plaudMcpRequest(tokenPayload.access_token, {
    jsonrpc: "2.0",
    id: initializeId,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "aistudio-owner-broker", version: "1" },
    },
  })
  if (initialized.response.status === 401) {
    return { status: "needs-auth", reason: "Plaud rejected owner token" }
  }
  if (!initialized.response.ok) {
    throw new Error(`Plaud initialize HTTP ${initialized.response.status}`)
  }
  const plaudSessionId = initialized.response.headers.get("mcp-session-id")
  const notification = await plaudMcpRequest(
    tokenPayload.access_token,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    plaudSessionId || undefined,
    { allowEmpty: true }
  )
  if (!notification.response.ok) {
    throw new Error(
      `Plaud initialized notification HTTP ${notification.response.status}`
    )
  }
  const callId = crypto.randomUUID()
  const operation = await plaudMcpRequest(
    tokenPayload.access_token,
    {
      jsonrpc: "2.0",
      id: callId,
      method: input.method,
      params:
        input.method === "tools/call"
          ? { name: input.toolName, arguments: toolArgs }
          : {},
    },
    plaudSessionId || undefined
  )
  if (operation.response.status === 401) {
    return { status: "needs-auth", reason: "Plaud rejected owner token" }
  }
  if (operation.response.status === 429) return { status: "rate-limited" }
  if (!operation.response.ok) {
    throw new Error(`Plaud MCP HTTP ${operation.response.status}`)
  }
  const payload = operation.payload
  if (!isRecord(payload)) throw new Error("Plaud MCP returned invalid data")
  return { status: "ok", result: payload.error ? payload : payload.result ?? null }
}

async function sharedCredentialJson(
  broker: AgentCredentialBroker,
  ownerEmail: string,
  name: string,
  sessionId: string
): Promise<Record<string, unknown>> {
  const credential = await broker.get(ownerEmail, name, {
    sharedOnly: true,
    sessionId,
  })
  if (!credential || credential.scope !== "shared") {
    throw new Error("Required operation credential is not configured")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(credential.value)
  } catch {
    throw new Error("Required operation credential is malformed")
  }
  return boundedRecord(parsed, "Operation credential")
}

export async function executeOpenAiImageOperation(input: {
  ownerEmail: string
  sessionId: string
  prompt: unknown
  size: unknown
  quality: unknown
  background: unknown
  referenceDataUrl: unknown
}): Promise<{ imageBase64: string }> {
  const sizes = new Set(["auto", "1024x1024", "1024x1536", "1536x1024"])
  const qualities = new Set(["auto", "low", "medium", "high"])
  const backgrounds = new Set(["auto", "opaque", "transparent"])
  if (
    typeof input.prompt !== "string" ||
    input.prompt.length === 0 ||
    input.prompt.length > 4000 ||
    typeof input.size !== "string" ||
    !sizes.has(input.size) ||
    typeof input.quality !== "string" ||
    !qualities.has(input.quality) ||
    typeof input.background !== "string" ||
    !backgrounds.has(input.background) ||
    (input.referenceDataUrl !== null &&
      input.referenceDataUrl !== undefined &&
      (typeof input.referenceDataUrl !== "string" ||
        input.referenceDataUrl.length > 12 * 1024 * 1024 ||
        !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(
          input.referenceDataUrl
        )))
  ) {
    throw new Error("Invalid image operation")
  }
  const broker = new AgentCredentialBroker()
  const credential = await broker.get(
    input.ownerEmail,
    "openai_api_key",
    { sharedOnly: true, sessionId: input.sessionId }
  )
  if (!credential || credential.scope !== "shared") {
    throw new Error("Image generation credential is not configured")
  }
  const reference =
    typeof input.referenceDataUrl === "string" ? input.referenceDataUrl : null
  const body: Record<string, unknown> = {
    model: "gpt-image-2",
    prompt: input.prompt,
    ...(input.size !== "auto" ? { size: input.size } : {}),
    ...(input.quality !== "auto" ? { quality: input.quality } : {}),
    ...(input.background !== "auto" ? { background: input.background } : {}),
    ...(reference ? { images: [{ image_url: reference }] } : {}),
  }
  const response = await fetch(
    reference
      ? "https://api.openai.com/v1/images/edits"
      : "https://api.openai.com/v1/images/generations",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.value}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    }
  )
  if (!response.ok) {
    throw new Error(`Image provider HTTP ${response.status}`)
  }
  const payload = await readBoundedJson(response, 32 * 1024 * 1024)
  const first =
    isRecord(payload) &&
    Array.isArray(payload.data) &&
    isRecord(payload.data[0])
      ? payload.data[0]
      : null
  if (
    typeof first?.b64_json !== "string" ||
    first.b64_json.length > 28 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/=]+$/.test(first.b64_json)
  ) {
    throw new Error("Image provider returned invalid image data")
  }
  return { imageBase64: first.b64_json }
}

async function redRoverAuthority(input: {
  ownerEmail: string
  sessionId: string
}): Promise<{
  username: string
  password: string
  staticApiKey: string | null
}> {
  const credential = await sharedCredentialJson(
    new AgentCredentialBroker(),
    input.ownerEmail,
    "redrover_credentials",
    input.sessionId
  )
  if (
    typeof credential.username !== "string" ||
    typeof credential.password !== "string"
  ) {
    throw new TypeError("Red Rover operation credential is malformed")
  }
  return {
    username: credential.username,
    password: credential.password,
    staticApiKey:
      typeof credential.apiKey === "string" ? credential.apiKey : null,
  }
}

async function redRoverGet(
  path: string,
  authority: Awaited<ReturnType<typeof redRoverAuthority>>,
  apiKey?: string
): Promise<unknown> {
  const response = await fetch(`${RED_ROVER_BASE_URL}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${authority.username}:${authority.password}`
      ).toString("base64")}`,
      Accept: "application/json",
      ...(apiKey ? { apiKey } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Red Rover API HTTP ${response.status}`)
  return readBoundedJson(response, 4 * 1024 * 1024)
}

async function redRoverOrganization(
  authority: Awaited<ReturnType<typeof redRoverAuthority>>
): Promise<{ orgId: string; apiKey: string; name?: string }> {
  const payload = await redRoverGet("/api/v1/organization", authority)
  const first = Array.isArray(payload) ? payload[0] : payload
  if (
    !isRecord(first) ||
    typeof first.orgId !== "string" ||
    first.orgId.length === 0 ||
    first.orgId.length > 256
  ) {
    throw new Error("Red Rover organization response is malformed")
  }
  const apiKey =
    typeof first.apiKey === "string" ? first.apiKey : authority.staticApiKey
  if (!apiKey) throw new Error("Red Rover organization API key is unavailable")
  const candidateName = first.name ?? first.orgName ?? first.organizationName
  if (
    candidateName !== undefined &&
    (typeof candidateName !== "string" ||
      candidateName.length === 0 ||
      candidateName.length > 256 ||
      hasAsciiControl(candidateName))
  ) {
    throw new Error("Red Rover organization name is malformed")
  }
  return {
    orgId: first.orgId,
    apiKey,
    ...(typeof candidateName === "string" ? { name: candidateName } : {}),
  }
}

function parseUtcDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const timestamp = Date.UTC(year, month - 1, day)
  const parsed = new Date(timestamp)
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null
  }
  return timestamp
}

function assertRedRoverDateRange(startDate: string, endDate: string): void {
  const start = parseUtcDay(startDate)
  const end = parseUtcDay(endDate)
  const daySpan =
    start === null || end === null ? -1 : (end - start) / 86_400_000
  if (
    start === null ||
    end === null ||
    daySpan < 0 ||
    daySpan >= MAX_RED_ROVER_DATE_SPAN_DAYS
  ) {
    throw new Error(
      `Red Rover date range must be at most ${MAX_RED_ROVER_DATE_SPAN_DAYS} inclusive days`
    )
  }
}

export async function executeRedRoverOperation(input: {
  ownerEmail: string
  sessionId: string
  operation: unknown
  startDate: unknown
  endDate: unknown
  filledFilter: unknown
}): Promise<unknown> {
  if (
    input.operation !== "organization" &&
    input.operation !== "vacancies"
  ) {
    throw new Error("Invalid Red Rover operation")
  }
  if (
    input.operation === "vacancies" &&
    (typeof input.startDate !== "string" ||
      typeof input.endDate !== "string" ||
      (input.filledFilter !== undefined &&
        input.filledFilter !== null &&
        input.filledFilter !== "filled" &&
        input.filledFilter !== "unfilled"))
  ) {
    throw new Error("Invalid Red Rover operation")
  }
  if (input.operation === "vacancies") {
    assertRedRoverDateRange(input.startDate as string, input.endDate as string)
  }

  const authority = await redRoverAuthority(input)
  const organization = await redRoverOrganization(authority)
  if (input.operation === "organization") {
    return {
      orgId: organization.orgId,
      ...(organization.name ? { name: organization.name } : {}),
    }
  }
  const allData: unknown[] = []
  let serializedBytes = 0
  for (let page = 1; page <= 200; page += 1) {
    const query = new URLSearchParams({
      fromDate: `${input.startDate}T00:00:00Z`,
      toDate: `${input.endDate}T23:59:59Z`,
      pageSize: "100",
      page: String(page),
      ...(input.filledFilter === "filled"
        ? { filled: "true" }
        : input.filledFilter === "unfilled"
          ? { filled: "false" }
          : {}),
    })
    const payload = await redRoverGet(
      `/api/v1/${encodeURIComponent(
        organization.orgId
      )}/Vacancy/details?${query}`,
      authority,
      organization.apiKey
    )
    if (!isRecord(payload)) throw new Error("Red Rover response is malformed")
    if (!Array.isArray(payload.data)) {
      throw new TypeError("Red Rover response data is malformed")
    }
    if (allData.length + payload.data.length > MAX_RED_ROVER_VACANCY_ITEMS) {
      throw new Error("Red Rover query exceeded the aggregate item limit")
    }
    for (const item of payload.data) {
      const serialized = JSON.stringify(item)
      serializedBytes += Buffer.byteLength(serialized, "utf8")
      if (serializedBytes > MAX_RED_ROVER_SERIALIZED_BYTES) {
        throw new Error("Red Rover query exceeded the aggregate byte limit")
      }
      allData.push(item)
    }
    if (payload.hasMoreData !== true) {
      return { data: allData, total: allData.length }
    }
  }
  throw new Error("Red Rover query exceeded the maximum page limit")
}

// ---------------------------------------------------------------------------
// Freshservice
// ---------------------------------------------------------------------------
//
// psd-freshservice used to read the owner's API key in plaintext via
// psd-credentials/get.js and call Freshservice from inside the model runtime.
// #1353 removed plaintext credential access — correctly — but the skill was
// never migrated, so it kept exec'ing a script that no longer exists. EVERY
// freshservice command has been dead since: the process fails before it even
// checks whether a key is provisioned, and the resulting error blames the
// user's credentials rather than the skill.
//
// The key now stays server-side, exactly like Red Rover above.

const FRESHSERVICE_DOMAIN = "psd401.freshservice.com"
const FRESHSERVICE_BASE_URL = `https://${FRESHSERVICE_DOMAIN}/api/v2`
const MAX_FRESHSERVICE_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * Exactly the Freshservice endpoints psd-freshservice uses, as
 * (method, path) pairs.
 *
 * This is the security boundary. The model composes the path, so without an
 * allowlist the "fetch a ticket" broker would be a general-purpose proxy that
 * signs arbitrary requests with the owner's API key — including admin
 * endpoints the skill never uses. Anchored patterns, numeric ids only, and a
 * restricted query charset (no "/", so a query string cannot smuggle extra
 * path segments).
 *
 * Adding a command means adding its route here — deliberately, so widening the
 * key's reach is a visible diff rather than a side effect.
 */
/**
 * Each route REBUILDS its pathname from literals plus the numeric ids it
 * captured, rather than passing the caller's string through.
 *
 * That distinction is the whole point. A predicate that merely *validates* the
 * input still hands the original attacker-controlled string to fetch(), which
 * is both a real hazard if a pattern is ever loosened and an SSRF finding no
 * static analyzer can discharge. Reconstructing means the final URL is
 * literals + Number(), so no caller-supplied character can reach the host.
 */
const FRESHSERVICE_ROUTES: ReadonlyArray<{
  method: "GET" | "POST" | "PUT"
  pattern: RegExp
  build: (id: number) => string
}> = [
  { method: "GET", pattern: /^\/tickets$/, build: () => "/tickets" },
  { method: "POST", pattern: /^\/tickets$/, build: () => "/tickets" },
  { method: "GET", pattern: /^\/tickets\/(\d+)$/, build: (id) => `/tickets/${id}` },
  { method: "PUT", pattern: /^\/tickets\/(\d+)$/, build: (id) => `/tickets/${id}` },
  {
    method: "POST",
    pattern: /^\/tickets\/(\d+)\/notes$/,
    build: (id) => `/tickets/${id}/notes`,
  },
  {
    method: "GET",
    pattern: /^\/tickets\/(\d+)\/requested_items$/,
    build: (id) => `/tickets/${id}/requested_items`,
  },
  { method: "GET", pattern: /^\/agents$/, build: () => "/agents" },
  { method: "GET", pattern: /^\/agents\/(\d+)$/, build: (id) => `/agents/${id}` },
  {
    method: "GET",
    pattern: /^\/requesters\/(\d+)$/,
    build: (id) => `/requesters/${id}`,
  },
  { method: "GET", pattern: /^\/workspaces$/, build: () => "/workspaces" },
  {
    method: "GET",
    pattern: /^\/workspaces\/(\d+)$/,
    build: (id) => `/workspaces/${id}`,
  },
  { method: "GET", pattern: /^\/approvals$/, build: () => "/approvals" },
]

/** Query keys the skill actually sends, with the value charset each may use. */
const FRESHSERVICE_QUERY_KEYS = new Set([
  "per_page",
  "page",
  "include",
  "email",
  "approver_id",
  "status",
  "parent",
  "updated_since",
  "order_type",
  "workspace_id",
  "query",
])
const FRESHSERVICE_VALUE_CHARS = /^[A-Za-z0-9_.,:+@ -]*$/

/**
 * Canonicalize one request, or return null if it is not allowlisted.
 *
 * Returns a NEWLY BUILT path string: literal segments, numeric ids passed
 * through Number(), and a query re-serialized from an allowlisted key set with
 * a value charset that excludes "/", ":"-schemes and "@", so a query can
 * neither smuggle path segments nor an alternate host.
 *
 * Splitting the query off BEFORE matching also keeps every pattern a static
 * anchored literal. Folding an optional query group into each pattern is the
 * obvious approach and the wrong one: it produces dynamically-built nested
 * quantifiers over an attacker-controlled string — a ReDoS hazard, and a lint
 * error.
 */
function canonicalFreshservicePath(method: string, path: string): string | null {
  const queryStart = path.indexOf("?")
  const pathname = queryStart === -1 ? path : path.slice(0, queryStart)
  const rawQuery = queryStart === -1 ? "" : path.slice(queryStart + 1)

  const route = FRESHSERVICE_ROUTES.find(
    (candidate) => candidate.method === method && candidate.pattern.test(pathname)
  )
  if (!route) return null

  const captured = route.pattern.exec(pathname)?.[1]
  const id = captured === undefined ? 0 : Number(captured)
  if (!Number.isSafeInteger(id) || id < 0) return null
  const canonicalPath = route.build(id)

  if (rawQuery.length === 0) return canonicalPath

  const query = canonicalFreshserviceQuery(rawQuery)
  if (query === null) return null
  return query.length > 0 ? `${canonicalPath}?${query}` : canonicalPath
}

/**
 * Re-serialize a query from an allowlisted key set, or null if anything in it
 * is unrecognized. Split out from the path canonicalizer to keep each half
 * under the complexity ceiling and independently readable.
 */
function canonicalFreshserviceQuery(rawQuery: string): string | null {
  const rebuilt = new URLSearchParams()
  for (const pair of rawQuery.split("&")) {
    if (pair.length === 0) continue
    const eq = pair.indexOf("=")
    if (eq === -1) return null
    const key = pair.slice(0, eq)
    if (!FRESHSERVICE_QUERY_KEYS.has(key)) return null
    let value: string
    try {
      value = decodeURIComponent(pair.slice(eq + 1))
    } catch {
      return null
    }
    if (!FRESHSERVICE_VALUE_CHARS.test(value)) return null
    rebuilt.append(key, value)
  }
  return rebuilt.toString()
}

/**
 * Proxy one allowlisted Freshservice call using the owner's stored API key.
 *
 * Returns the upstream status alongside the body instead of throwing on
 * non-2xx: the skill maps 429 to a "wait, don't retry" message and 404 to "no
 * such ticket", and collapsing those into a generic error was what made the
 * old client's failures unreadable.
 */
/**
 * Validate one Freshservice request, or throw.
 *
 * Split out from the executor so the request-shaping rules read as a single
 * unit — and so neither half trips the complexity ceiling.
 */
function validatedFreshserviceRequest(
  rawPath: unknown,
  rawMethod: unknown
): { path: string; method: "GET" | "POST" | "PUT" } {
  const method = rawMethod === undefined ? "GET" : rawMethod
  if (method !== "GET" && method !== "POST" && method !== "PUT") {
    throw new Error("Invalid Freshservice method")
  }
  if (
    typeof rawPath !== "string" ||
    !rawPath.startsWith("/") ||
    rawPath.length > 512 ||
    hasAsciiControl(rawPath)
  ) {
    throw new Error("Invalid Freshservice path")
  }
  const canonical = canonicalFreshservicePath(method, rawPath)
  if (canonical === null) {
    // Named explicitly: an unlisted endpoint is a skill change that needs a
    // route added, not a transient failure the agent should retry.
    throw new Error(`Freshservice route not allowed: ${method} ${rawPath}`)
  }
  // The REBUILT path, never rawPath — this is what keeps caller-supplied
  // characters out of the URL that gets fetched.
  return { path: canonical, method }
}

export async function executeFreshserviceOperation(input: {
  ownerEmail: string
  sessionId: string
  path: unknown
  method: unknown
  body: unknown
}): Promise<unknown> {
  const { path, method } = validatedFreshserviceRequest(input.path, input.method)

  const credential = await new AgentCredentialBroker().getUserOnly(
    input.ownerEmail,
    "freshservice_api_key",
    { sessionId: input.sessionId }
  )
  if (!credential) {
    // Distinct, machine-readable outcome — the skill turns this into the
    // "paste your key" prompt. It is NOT an error: a user who has never
    // registered a key is in a normal state.
    return { status: 0, ok: false, code: "credential_missing" }
  }

  const response = await fetch(`${FRESHSERVICE_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${credential.value}:X`).toString(
        "base64"
      )}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(method === "GET"
      ? {}
      : { body: JSON.stringify(boundedRecord(input.body ?? {}, "Freshservice body")) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })

  if (response.status === 429) {
    return {
      status: 429,
      ok: false,
      code: "rate_limited",
      retryAfter: response.headers.get("retry-after") ?? "unknown",
    }
  }

  // A body that is absent or unparseable is normal for some Freshservice
  // responses (204 on update). Keep the status — it is the useful half.
  const data = await readBoundedJson(
    response,
    MAX_FRESHSERVICE_RESPONSE_BYTES
  ).catch(() => null)
  // Derive success from the status rather than reading `response.ok`. The
  // status is the value the skill branches on anyway, and deriving it keeps
  // this correct against any fetch implementation that omits the convenience
  // property.
  const status = response.status
  return { status, ok: status >= 200 && status < 300, data }
}
