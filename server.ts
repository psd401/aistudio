/**
 * Custom Next.js Server with WebSocket Support
 *
 * Uses Bun.serve() with native WebSocket upgrade — the `ws` npm package's
 * handleUpgrade is incompatible with bun's node:http shim (close code 1006).
 * A lightweight shim (BunWebSocketShim) adapts bun's ServerWebSocket to
 * the event-based ws.WebSocket interface expected by ws-handler.ts.
 *
 * HTTP bridge uses ReadableStream for SSR streaming compatibility.
 *
 * Usage:
 *   Development: bun run dev:voice / bun run dev:local
 *   Production:  bun run voice-server.js
 *   Docker:      CMD ["bun", "run", "server.ts"]
 *
 * Issue #872, #873
 */

import http from "node:http"
import { PassThrough } from "node:stream"
import type { Socket } from "node:net"
import { parse } from "node:url"
import type WebSocket from "ws"
import type { ServerWebSocket } from "bun"
import next from "next"

const VOICE_WS_PATH = "/api/nexus/voice"
const WS_MAX_PAYLOAD = 65536 // 64KB — must match lib/voice/constants.ts

const dev = process.env.NODE_ENV !== "production"
const hostname = process.env.HOSTNAME || "0.0.0.0"
const port = Number.parseInt(process.env.PORT || "3000", 10)

/**
 * Validate the Origin header on WebSocket upgrade to prevent CSWSH.
 */
function isAllowedOrigin(origin: string | null | undefined, host: string | null | undefined): boolean {
  if (dev) return true
  if (!origin) return false

  const allowedOrigins: string[] = []
  if (process.env.ALLOWED_ORIGINS) {
    allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()))
  }
  const appUrl = process.env.NEXTAUTH_URL || process.env.APP_URL
  if (appUrl) allowedOrigins.push(appUrl.replace(/\/+$/, ""))

  if (allowedOrigins.length === 0) {
    if (!host) return false
    return origin === `http://${host}` || origin === `https://${host}`
  }

  return allowedOrigins.includes(origin)
}

// ─── Bun WebSocket Shim ───────────────────────────────────────────────────────
// Adapts bun's ServerWebSocket to the event-based ws.WebSocket interface
// used by ws-handler.ts. Buffers messages arriving before listeners register
// (race condition: ws-handler registers ws.on('message') after async auth).

interface BunWsData {
  headers: Record<string, string>
  url: string
  shim: BunWebSocketShim | null
}

class BunWebSocketShim {
  private _listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  private _pendingMessages: Buffer[] = []
  private _bunWs: ServerWebSocket<BunWsData>

  constructor(bunWs: ServerWebSocket<BunWsData>) {
    this._bunWs = bunWs
  }

  get readyState(): number {
    return this._bunWs.readyState
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    if (!this._listeners[event]) this._listeners[event] = []
    this._listeners[event].push(handler)
    // Drain buffered messages when message listener is first registered
    if (event === "message" && this._pendingMessages.length > 0) {
      const queued = this._pendingMessages.splice(0)
      for (const msg of queued) handler(msg)
    }
    return this
  }

  removeAllListeners(event: string): this {
    delete this._listeners[event]
    return this
  }

  send(data: string | Buffer, cb?: (err?: Error) => void): void {
    try {
      this._bunWs.send(data)
      cb?.()
    } catch (err) {
      cb?.(err as Error)
    }
  }

  close(code?: number, reason?: string): void {
    try { this._bunWs.close(code, reason) } catch { /* already closed */ }
  }

  ping(): void {
    try { this._bunWs.ping() } catch { /* ignore */ }
  }

  /** Called by websocket handlers to dispatch events to listeners */
  _emit(event: string, ...args: unknown[]): void {
    const handlers = this._listeners[event]
    if (!handlers || handlers.length === 0) {
      // Buffer messages arriving before listener registration
      if (event === "message" && args[0]) {
        this._pendingMessages.push(args[0] as Buffer)
      }
      return
    }
    for (const handler of handlers) {
      handler(...args)
    }
  }
}

// ─── Streaming HTTP Bridge ────────────────────────────────────────────────────
// Bridges Bun.serve() Request/Response to Next.js IncomingMessage/ServerResponse.
// Uses ReadableStream for SSR streaming compatibility (React Server Components).

function handleNextRequest(
  req: Request,
  remoteAddress: string,
  nextHandler: ReturnType<ReturnType<typeof next>["getRequestHandler"]>
): Promise<Response> {
  return new Promise<Response>((resolve) => {
    const url = new URL(req.url)
    const fakeSocket = new PassThrough()
    Object.assign(fakeSocket, { remoteAddress, encrypted: url.protocol === "https:" })

    const nodeReq = new http.IncomingMessage(fakeSocket as unknown as Socket)
    nodeReq.url = url.pathname + url.search
    nodeReq.method = req.method
    nodeReq.headers = Object.fromEntries(req.headers.entries())

    const nodeRes = new http.ServerResponse(nodeReq)

    // Stream response body via ReadableStream (supports SSR streaming)
    let streamController: ReadableStreamDefaultController<Uint8Array>
    let headersSent = false
    let resolved = false

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
    })

    const sendHeaders = () => {
      if (headersSent) return
      headersSent = true
      const headers = new Headers()
      const rawHeaders = nodeRes.getHeaders()
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (value === undefined) continue
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v)
        } else {
          headers.set(key, String(value))
        }
      }
      resolved = true
      resolve(new Response(body, { status: nodeRes.statusCode, headers }))
    }

    const origWriteHead = nodeRes.writeHead.bind(nodeRes)
    nodeRes.writeHead = ((...args: unknown[]) => {
      const result = (origWriteHead as (...a: unknown[]) => http.ServerResponse)(...args)
      sendHeaders()
      return result
    }) as typeof nodeRes.writeHead

    const origWrite = nodeRes.write.bind(nodeRes)
    nodeRes.write = ((chunk: unknown, ...args: unknown[]) => {
      sendHeaders()
      if (chunk) {
        streamController.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
      }
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args)
    }) as typeof nodeRes.write

    const origEnd = nodeRes.end.bind(nodeRes)
    nodeRes.end = ((chunk?: unknown, ...args: unknown[]) => {
      if (chunk) {
        sendHeaders()
        streamController.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
      }
      streamController.close()
      if (!resolved) sendHeaders()
      return (origEnd as (...a: unknown[]) => unknown)(chunk, ...args)
    }) as typeof nodeRes.end

    // Stream request body to nodeReq
    if (req.body) {
      const reader = req.body.getReader()
      const pump = (): void => {
        reader.read().then((result) => {
          if (result.done) { nodeReq.push(null); return }
          nodeReq.push(Buffer.from(result.value))
          pump()
        })
      }
      pump()
    } else {
      nodeReq.push(null)
    }

    nextHandler(nodeReq, nodeRes, parse(nodeReq.url || "/", true))
  })
}

// ─── Server ───────────────────────────────────────────────────────────────────

async function main() {
  const app = next({ dev, hostname, port })
  const nextHandler = app.getRequestHandler()

  await app.prepare()

  // eslint-disable-next-line no-console -- Server startup message
  console.log(`[voice-server] Starting on ${hostname}:${port} (bun)`)

  const server = Bun.serve<BunWsData>({
    port,
    hostname,

    async fetch(req, server) {
      const url = new URL(req.url)

      // Voice WebSocket upgrade
      if (url.pathname === VOICE_WS_PATH) {
        const upgradeHeader = req.headers.get("upgrade")
        if (upgradeHeader?.toLowerCase() === "websocket") {
          if (!isAllowedOrigin(req.headers.get("origin"), req.headers.get("host"))) {
            return new Response("Forbidden", { status: 403 })
          }

          const data: BunWsData = {
            headers: Object.fromEntries(req.headers.entries()),
            url: req.url,
            shim: null,
          }

          if (server.upgrade(req, { data })) {
            return undefined as unknown as Response
          }
          return new Response("WebSocket upgrade failed", { status: 500 })
        }
      }

      // All other requests → Next.js via streaming bridge
      const remoteAddress = server.requestIP(req)?.address ?? "127.0.0.1"
      return handleNextRequest(req, remoteAddress, nextHandler)
    },

    websocket: {
      maxPayloadLength: WS_MAX_PAYLOAD,

      open(bunWs) {
        const wsData = bunWs.data
        const shim = new BunWebSocketShim(bunWs)
        wsData.shim = shim

        const fakeSocket = new PassThrough()
        const req = new http.IncomingMessage(fakeSocket as unknown as Socket)
        req.url = wsData.url
        req.headers = wsData.headers

        import("@/lib/voice/ws-handler").then(({ handleVoiceConnection }) => {
          handleVoiceConnection(shim as unknown as WebSocket, req).catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            // eslint-disable-next-line no-console -- Outside Next.js runtime
            console.error("[voice-server] Connection error:", message)
            try { shim.close(4500, "Internal error") } catch { /* already closed */ }
          })
        })
      },

      message(bunWs, message) {
        const buf = typeof message === "string" ? Buffer.from(message) : Buffer.from(message)
        bunWs.data.shim?._emit("message", buf)
      },

      close(bunWs, code, reason) {
        bunWs.data.shim?._emit("close", code, Buffer.from(reason || ""))
      },
    },
  })

  void server
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- Server startup errors must go to stderr
  console.error("Failed to start server:", err)
  process.exit(1)
})
