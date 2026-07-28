import { safeFetch } from "@/lib/security/safe-fetch"

export const CALLER_BOUND_MARKER = "[caller-bound]"
const MUTATING_WORKFLOW_TOOL_PREFIXES = [
  "approve_",
  "cancel_",
  "create_",
  "delete_",
  "reject_",
  "submit_",
  "update_",
] as const
export const WORKFLOW_SSE_LIMITS = {
  rawBytes: 4 * 1024 * 1024,
  chunkBytes: 256 * 1024,
  bufferBytes: 256 * 1024,
  frameBytes: 128 * 1024,
  lineBytes: 64 * 1024,
  dataBytes: 128 * 1024,
  frames: 1_000,
  resultBytes: 256 * 1024,
  headerTimeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  requestTimeoutMs: 60_000,
  totalTimeoutMs: 150_000,
} as const

interface SseFrame {
  event: string
  data: string
}

interface JsonRpcResponse {
  id?: number
  result?: unknown
  error?: { message?: string; [key: string]: unknown }
}

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void
  reject: (error: Error) => void
}

export interface WorkflowGatewayTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export class WorkflowGatewayError extends Error {
  constructor(
    message: string,
    readonly code: "configuration" | "request" | "transport" | "tool",
    readonly detail?: unknown
  ) {
    super(message)
    this.name = "WorkflowGatewayError"
  }
}

export function parseSseFrames(buffer: string): {
  frames: SseFrame[]
  rest: string
} {
  if (Buffer.byteLength(buffer, "utf8") > WORKFLOW_SSE_LIMITS.bufferBytes) {
    throw new WorkflowGatewayError("Gateway SSE buffer is too large", "transport")
  }
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n")
  const rest = parts.pop() ?? ""
  const frames: SseFrame[] = []
  for (const part of parts) {
    if (!part.trim()) continue
    if (Buffer.byteLength(part, "utf8") > WORKFLOW_SSE_LIMITS.frameBytes) {
      throw new WorkflowGatewayError("Gateway SSE frame is too large", "transport")
    }
    let event = "message"
    const data: string[] = []
    for (const line of part.split("\n")) {
      if (Buffer.byteLength(line, "utf8") > WORKFLOW_SSE_LIMITS.lineBytes) {
        throw new WorkflowGatewayError("Gateway SSE line is too large", "transport")
      }
      if (line.startsWith(":")) continue
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim()
      } else if (line.startsWith("data:")) {
        data.push(line.slice("data:".length).replace(/^ /, ""))
      }
    }
    const joinedData = data.join("\n")
    if (Buffer.byteLength(joinedData, "utf8") > WORKFLOW_SSE_LIMITS.dataBytes) {
      throw new WorkflowGatewayError("Gateway SSE data is too large", "transport")
    }
    frames.push({ event, data: joinedData })
    if (frames.length > WORKFLOW_SSE_LIMITS.frames) {
      throw new WorkflowGatewayError("Gateway sent too many SSE frames", "transport")
    }
  }
  return { frames, rest }
}

export function resolveGatewayEndpoint(
  sseUrl: string,
  announced: string
): URL {
  const base = new URL(sseUrl)
  const endpoint = new URL(announced, base)
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== base.origin ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new WorkflowGatewayError(
      "Gateway announced an endpoint outside its configured HTTPS origin",
      "transport"
    )
  }
  return endpoint
}

export function unwrapWorkflowToolResult(result: unknown): {
  isError: boolean
  data: unknown
} {
  if (!result || typeof result !== "object") {
    return { isError: false, data: result ?? null }
  }
  const value = result as {
    isError?: unknown
    content?: unknown
  }
  const first =
    Array.isArray(value.content) &&
    value.content[0] &&
    typeof value.content[0] === "object"
      ? (value.content[0] as { text?: unknown })
      : null
  if (typeof first?.text !== "string") {
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") >
      WORKFLOW_SSE_LIMITS.resultBytes
    ) {
      throw new WorkflowGatewayError("Gateway result is too large", "transport")
    }
    return { isError: Boolean(value.isError), data: result }
  }
  if (Buffer.byteLength(first.text, "utf8") > WORKFLOW_SSE_LIMITS.resultBytes) {
    throw new WorkflowGatewayError("Gateway result is too large", "transport")
  }
  try {
    return {
      isError: Boolean(value.isError),
      data: JSON.parse(first.text),
    }
  } catch {
    return { isError: Boolean(value.isError), data: first.text }
  }
}

export class WorkflowGatewayClient {
  private readonly controller = new AbortController()
  private readonly pending = new Map<number, PendingRequest>()
  private endpoint: URL | null = null
  private endpointResolve: (() => void) | null = null
  private endpointReject: ((error: Error) => void) | null = null
  private nextId = 1
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private readonly totalTimer: ReturnType<typeof setTimeout>
  private readonly externalAbort: (() => void) | null
  private readonly externalSignal: AbortSignal | undefined

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof safeFetch = safeFetch,
    externalSignal?: AbortSignal,
  ) {
    this.externalSignal = externalSignal
    this.totalTimer = setTimeout(
      () => {
        const error = new WorkflowGatewayError(
          "Gateway request exceeded its total timeout",
          "transport",
        )
        this.controller.abort(error)
        void this.streamReader?.cancel(error)
        this.failAll(error)
      },
      WORKFLOW_SSE_LIMITS.totalTimeoutMs,
    )
    this.externalAbort = externalSignal
      ? () => this.controller.abort(externalSignal.reason)
      : null
    if (externalSignal?.aborted) {
      this.controller.abort(externalSignal.reason)
    } else if (externalSignal && this.externalAbort) {
      externalSignal.addEventListener("abort", this.externalAbort, { once: true })
    }
  }

  async connect(): Promise<void> {
    let response: Response
    const headerTimer = setTimeout(
      () => this.controller.abort("workflow gateway header timeout"),
      WORKFLOW_SSE_LIMITS.headerTimeoutMs,
    )
    try {
      response = await this.fetchImpl(this.url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "text/event-stream",
        },
        signal: this.controller.signal,
      })
    } catch (error) {
      throw new WorkflowGatewayError(
        `Failed to open gateway stream: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "transport"
      )
    } finally {
      clearTimeout(headerTimer)
    }
    if (!response.ok || !response.body) {
      throw new WorkflowGatewayError(
        `Gateway stream returned HTTP ${response.status}`,
        "transport"
      )
    }
    const contentType = response.headers.get("content-type")
    const declaredLength = response.headers.get("content-length")
    if (
      contentType?.split(";", 1)[0]?.trim().toLowerCase() !==
        "text/event-stream" ||
      (declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) ||
          Number(declaredLength) > WORKFLOW_SSE_LIMITS.rawBytes))
    ) {
      throw new WorkflowGatewayError(
        "Gateway returned an invalid or oversized SSE stream",
        "transport",
      )
    }
    this.streamReader = response.body.getReader()
    void this.consume(this.streamReader).catch((error) => {
      this.failAll(
        error instanceof Error
          ? error
          : new WorkflowGatewayError(String(error), "transport")
      )
    })
    await this.waitForEndpoint()
  }

  private async consume(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let buffer = ""
    let rawBytes = 0
    let frameCount = 0
    for (;;) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const read = reader.read()
      const timeout = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => {
          this.controller.abort("workflow gateway idle timeout")
          void reader.cancel("workflow gateway idle timeout")
          reject(
            new WorkflowGatewayError("Gateway SSE stream timed out", "transport"),
          )
        }, WORKFLOW_SSE_LIMITS.idleTimeoutMs)
      })
      const { value, done } = await Promise.race([read, timeout]).finally(() => {
        if (idleTimer) clearTimeout(idleTimer)
      })
      if (done) {
        throw new WorkflowGatewayError(
          "Gateway stream closed unexpectedly",
          "transport"
        )
      }
      if (
        value.byteLength > WORKFLOW_SSE_LIMITS.chunkBytes ||
        rawBytes + value.byteLength > WORKFLOW_SSE_LIMITS.rawBytes
      ) {
        await reader.cancel("workflow gateway SSE limit exceeded")
        throw new WorkflowGatewayError("Gateway SSE stream is too large", "transport")
      }
      rawBytes += value.byteLength
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseFrames(buffer)
      buffer = parsed.rest
      frameCount += parsed.frames.length
      if (frameCount > WORKFLOW_SSE_LIMITS.frames) {
        await reader.cancel("workflow gateway frame limit exceeded")
        throw new WorkflowGatewayError("Gateway sent too many SSE frames", "transport")
      }
      for (const frame of parsed.frames) this.handleFrame(frame)
    }
  }

  private handleFrame(frame: SseFrame): void {
    if (frame.event === "endpoint") {
      try {
        this.endpoint = resolveGatewayEndpoint(this.url, frame.data.trim())
        this.endpointResolve?.()
      } catch (error) {
        this.endpointReject?.(
          error instanceof Error ? error : new Error(String(error))
        )
      } finally {
        this.endpointResolve = null
        this.endpointReject = null
      }
      return
    }
    let response: JsonRpcResponse
    try {
      response = JSON.parse(frame.data) as JsonRpcResponse
    } catch {
      return
    }
    if (typeof response.id !== "number") return
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    pending.resolve(response)
  }

  private waitForEndpoint(): Promise<void> {
    if (this.endpoint) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.endpointResolve = null
        this.endpointReject = null
        reject(
          new WorkflowGatewayError(
            "Gateway did not announce its endpoint within 30 seconds",
            "transport"
          )
        )
      }, 30_000)
      this.endpointResolve = () => {
        clearTimeout(timer)
        resolve()
      }
      this.endpointReject = (error) => {
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.endpointReject?.(error)
    this.endpointResolve = null
    this.endpointReject = null
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.endpoint) await this.waitForEndpoint()
    const endpoint = this.endpoint
    if (!endpoint) {
      throw new WorkflowGatewayError(
        "Gateway endpoint is unavailable",
        "transport"
      )
    }
    const id = this.nextId++
    const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new WorkflowGatewayError(
            `Gateway did not respond to ${method} within 60 seconds`,
            "transport"
          )
        )
      }, WORKFLOW_SSE_LIMITS.requestTimeoutMs)
      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer)
          resolve(response)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
    let post: Response
    try {
      post = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: this.controller.signal,
      })
    } catch (error) {
      this.pending.get(id)?.reject(
        new WorkflowGatewayError(
          `Failed to send ${method}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "transport"
        )
      )
      this.pending.delete(id)
      return responsePromise
    }
    if (!post.ok) {
      this.pending.get(id)?.reject(
        new WorkflowGatewayError(
          `Gateway rejected ${method} with HTTP ${post.status}`,
          "transport"
        )
      )
      this.pending.delete(id)
      return responsePromise
    }
    const response = await responsePromise
    if (response.error) {
      throw new WorkflowGatewayError(
        response.error.message ?? `Gateway rejected ${method}`,
        "tool",
        response.error
      )
    }
    return response.result
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (!this.endpoint) await this.waitForEndpoint()
    if (!this.endpoint) return
    await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal: this.controller.signal,
    })
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "psd-workflow-gateway-broker",
        version: "1.0.0",
      },
    })
    await this.notify("notifications/initialized", {})
  }

  close(): void {
    clearTimeout(this.totalTimer)
    if (this.externalSignal && this.externalAbort) {
      this.externalSignal.removeEventListener("abort", this.externalAbort)
    }
    this.controller.abort()
    void this.streamReader?.cancel("workflow gateway client closed")
    this.streamReader = null
    this.failAll(
      new WorkflowGatewayError("Gateway client closed", "transport")
    )
  }
}

export interface WorkflowGatewayConfig {
  url: string
  token: string
}

interface GatewayToolsResult {
  nextCursor?: unknown
  tools?: unknown
}

interface GatewayToolsPage {
  nextCursor?: string
  tools: WorkflowGatewayTool[]
}

interface GatewayToolsCache {
  config: WorkflowGatewayConfig
  expiresAt: number
  tools: WorkflowGatewayTool[]
}

const GATEWAY_TOOLS_CACHE_TTL_MS = 30_000
const MAX_GATEWAY_TOOLS_LIST_PAGES = 100
const MAX_GATEWAY_TOOLS_CURSOR_LENGTH = 4_096
let gatewayToolsCache: GatewayToolsCache | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function sameConfig(
  left: WorkflowGatewayConfig,
  right: WorkflowGatewayConfig
): boolean {
  return left.url === right.url && left.token === right.token
}

function encodedByteLength(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value)
    return typeof encoded === "string"
      ? Buffer.byteLength(encoded, "utf8")
      : null
  } catch {
    return null
  }
}

function parseGatewayToolsPage(result: unknown): GatewayToolsPage {
  const encodedBytes = encodedByteLength(result)
  if (
    encodedBytes === null ||
    encodedBytes > WORKFLOW_SSE_LIMITS.resultBytes
  ) {
    throw new WorkflowGatewayError("Gateway tool roster is too large", "transport")
  }
  const value = isRecord(result) ? (result as GatewayToolsResult) : null
  if (!value || !Array.isArray(value.tools)) {
    throw new WorkflowGatewayError(
      "Gateway returned an invalid tools/list result",
      "transport"
    )
  }

  const nextCursor = value.nextCursor
  if (
    nextCursor !== undefined &&
    (typeof nextCursor !== "string" ||
      nextCursor.length === 0 ||
      nextCursor.length > MAX_GATEWAY_TOOLS_CURSOR_LENGTH)
  ) {
    throw new WorkflowGatewayError(
      "Gateway returned an invalid tools/list cursor",
      "transport"
    )
  }

  const names = new Set<string>()
  const tools = value.tools.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new WorkflowGatewayError(
        "Gateway returned an invalid tool definition",
        "transport"
      )
    }
    const name = candidate.name
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 256 ||
      name.trim() !== name ||
      names.has(name)
    ) {
      throw new WorkflowGatewayError(
        "Gateway returned an invalid or duplicate tool name",
        "transport"
      )
    }
    names.add(name)
    const description =
      typeof candidate.description === "string" ? candidate.description : ""
    const inputSchema = isRecord(candidate.inputSchema)
      ? candidate.inputSchema
      : (Object.create(null) as Record<string, unknown>)
    return { name, description, inputSchema }
  })
  return { tools, nextCursor }
}

export function parseGatewayToolsList(result: unknown): WorkflowGatewayTool[] {
  return parseGatewayToolsPage(result).tools
}

export function getCallerBoundArgumentNames(
  inputSchema: Record<string, unknown>
): string[] {
  const properties = isRecord(inputSchema.properties)
    ? inputSchema.properties
    : null
  if (!properties) return []
  return Object.entries(properties).flatMap(([name, schema]) => {
    if (!isRecord(schema)) return []
    return typeof schema.description === "string" &&
      schema.description.includes(CALLER_BOUND_MARKER)
      ? [name]
      : []
  })
}

export function isMutatingWorkflowToolName(toolName: string): boolean {
  return MUTATING_WORKFLOW_TOOL_PREFIXES.some((prefix) =>
    toolName.startsWith(prefix)
  )
}

async function listGatewayToolsWithClient(
  client: WorkflowGatewayClient
): Promise<WorkflowGatewayTool[]> {
  const tools: WorkflowGatewayTool[] = []
  const names = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (let pageNumber = 1; ; pageNumber += 1) {
    if (pageNumber > MAX_GATEWAY_TOOLS_LIST_PAGES) {
      throw new WorkflowGatewayError(
        "Gateway tools/list pagination exceeded its page limit",
        "transport"
      )
    }
    const page = parseGatewayToolsPage(
      await client.request(
        "tools/list",
        cursor === undefined ? {} : { cursor }
      )
    )
    for (const tool of page.tools) {
      if (names.has(tool.name)) {
        throw new WorkflowGatewayError(
          "Gateway returned an invalid or duplicate tool name",
          "transport"
        )
      }
      names.add(tool.name)
      tools.push(tool)
    }
    const rosterBytes = encodedByteLength({ tools })
    if (
      rosterBytes === null ||
      rosterBytes > WORKFLOW_SSE_LIMITS.resultBytes
    ) {
      throw new WorkflowGatewayError(
        "Gateway tool roster is too large",
        "transport"
      )
    }
    if (page.nextCursor === undefined) return tools
    if (cursors.has(page.nextCursor)) {
      throw new WorkflowGatewayError(
        "Gateway tools/list pagination repeated a cursor",
        "transport"
      )
    }
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
}

async function fetchGatewayTools(
  config: WorkflowGatewayConfig,
  fetchImpl?: typeof safeFetch,
  abortSignal?: AbortSignal
): Promise<WorkflowGatewayTool[]> {
  const client = new WorkflowGatewayClient(
    config.url,
    config.token,
    fetchImpl,
    abortSignal
  )
  try {
    await client.connect()
    await client.initialize()
    return await listGatewayToolsWithClient(client)
  } finally {
    client.close()
  }
}

export async function listGatewayTools(
  config: WorkflowGatewayConfig,
  fetchImpl?: typeof safeFetch,
  abortSignal?: AbortSignal
): Promise<WorkflowGatewayTool[]> {
  const now = Date.now()
  if (
    gatewayToolsCache &&
    gatewayToolsCache.expiresAt > now &&
    sameConfig(gatewayToolsCache.config, config)
  ) {
    return gatewayToolsCache.tools
  }
  // Do not share a cold-cache promise: its abort signal belongs to one request.
  const tools = await fetchGatewayTools(config, fetchImpl, abortSignal)
  gatewayToolsCache = {
    config: { ...config },
    expiresAt: Date.now() + GATEWAY_TOOLS_CACHE_TTL_MS,
    tools,
  }
  return tools
}

export function clearGatewayToolsCache(): void {
  gatewayToolsCache = null
}

/**
 * Discovers the tool and prepares its arguments immediately before invocation
 * on one MCP session. Security-sensitive argument binding therefore uses the
 * schema associated with the execution, never the read-only discovery cache.
 */
export async function executeWorkflowGatewayTool(
  config: WorkflowGatewayConfig,
  toolName: string,
  prepareArguments: (tool: WorkflowGatewayTool) => Record<string, unknown>,
  fetchImpl?: typeof safeFetch,
  abortSignal?: AbortSignal,
): Promise<{ isError: boolean; data: unknown }> {
  const client = new WorkflowGatewayClient(
    config.url,
    config.token,
    fetchImpl,
    abortSignal,
  )
  try {
    await client.connect()
    await client.initialize()
    const tools = await listGatewayToolsWithClient(client)
    const tool = tools.find((candidate) => candidate.name === toolName)
    if (!tool) {
      throw new WorkflowGatewayError(
        "Gateway tool is not available in the live roster",
        "request"
      )
    }
    const args = prepareArguments(tool)
    const result = await client.request("tools/call", {
      name: toolName,
      arguments: args,
    })
    const unwrapped = unwrapWorkflowToolResult(result)
    if (
      Buffer.byteLength(JSON.stringify(unwrapped), "utf8") >
      WORKFLOW_SSE_LIMITS.resultBytes
    ) {
      throw new WorkflowGatewayError("Gateway result is too large", "transport")
    }
    return unwrapped
  } finally {
    client.close()
  }
}

/** Test seam for the route without replacing this module process-wide. */
export const workflowGatewayDependencies = {
  execute: executeWorkflowGatewayTool,
  listTools: listGatewayTools,
}
