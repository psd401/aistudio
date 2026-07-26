import { safeFetch } from "@/lib/security/safe-fetch"

export const CLASSIFIED_EVALUATION_TOOLS = new Set([
  "get_classified_evaluation_schema",
  "list_supervised_employees",
  "submit_classified_evaluation",
])

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

export class ClassifiedGatewayError extends Error {
  constructor(
    message: string,
    readonly code: "configuration" | "transport" | "tool",
    readonly detail?: unknown
  ) {
    super(message)
    this.name = "ClassifiedGatewayError"
  }
}

export function parseSseFrames(buffer: string): {
  frames: SseFrame[]
  rest: string
} {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n")
  const rest = parts.pop() ?? ""
  const frames: SseFrame[] = []
  for (const part of parts) {
    if (!part.trim()) continue
    let event = "message"
    const data: string[] = []
    for (const line of part.split("\n")) {
      if (line.startsWith(":")) continue
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim()
      } else if (line.startsWith("data:")) {
        data.push(line.slice("data:".length).replace(/^ /, ""))
      }
    }
    frames.push({ event, data: data.join("\n") })
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
    throw new ClassifiedGatewayError(
      "Gateway announced an endpoint outside its configured HTTPS origin",
      "transport"
    )
  }
  return endpoint
}

export function unwrapClassifiedToolResult(result: unknown): {
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
    return { isError: Boolean(value.isError), data: result }
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

export class ClassifiedGatewayClient {
  private readonly controller = new AbortController()
  private readonly pending = new Map<number, PendingRequest>()
  private endpoint: URL | null = null
  private endpointResolve: (() => void) | null = null
  private endpointReject: ((error: Error) => void) | null = null
  private nextId = 1

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof safeFetch = safeFetch
  ) {}

  async connect(): Promise<void> {
    let response: Response
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
      throw new ClassifiedGatewayError(
        `Failed to open gateway stream: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "transport"
      )
    }
    if (!response.ok || !response.body) {
      throw new ClassifiedGatewayError(
        `Gateway stream returned HTTP ${response.status}`,
        "transport"
      )
    }
    void this.consume(response.body.getReader()).catch((error) => {
      this.failAll(
        error instanceof Error
          ? error
          : new ClassifiedGatewayError(String(error), "transport")
      )
    })
    await this.waitForEndpoint()
  }

  private async consume(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        throw new ClassifiedGatewayError(
          "Gateway stream closed unexpectedly",
          "transport"
        )
      }
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseFrames(buffer)
      buffer = parsed.rest
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
          new ClassifiedGatewayError(
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
      throw new ClassifiedGatewayError(
        "Gateway endpoint is unavailable",
        "transport"
      )
    }
    const id = this.nextId++
    const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new ClassifiedGatewayError(
            `Gateway did not respond to ${method} within 120 seconds`,
            "transport"
          )
        )
      }, 120_000)
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
        new ClassifiedGatewayError(
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
        new ClassifiedGatewayError(
          `Gateway rejected ${method} with HTTP ${post.status}`,
          "transport"
        )
      )
      this.pending.delete(id)
      return responsePromise
    }
    const response = await responsePromise
    if (response.error) {
      throw new ClassifiedGatewayError(
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
        name: "psd-classified-evaluation-broker",
        version: "1.0.0",
      },
    })
    await this.notify("notifications/initialized", {})
  }

  close(): void {
    this.controller.abort()
    this.failAll(
      new ClassifiedGatewayError("Gateway client closed", "transport")
    )
  }
}

export async function executeClassifiedGatewayTool(
  config: { url: string; token: string },
  toolName: string,
  args: Record<string, unknown>,
  fetchImpl?: typeof safeFetch
): Promise<{ isError: boolean; data: unknown }> {
  if (!CLASSIFIED_EVALUATION_TOOLS.has(toolName)) {
    throw new ClassifiedGatewayError("Unsupported gateway tool", "tool")
  }
  const client = new ClassifiedGatewayClient(
    config.url,
    config.token,
    fetchImpl
  )
  try {
    await client.connect()
    await client.initialize()
    const result = await client.request("tools/call", {
      name: toolName,
      arguments: args,
    })
    return unwrapClassifiedToolResult(result)
  } finally {
    client.close()
  }
}

/** Test seam for the route without replacing this module process-wide. */
export const classifiedGatewayDependencies = {
  execute: executeClassifiedGatewayTool,
}
