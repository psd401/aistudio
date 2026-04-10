/**
 * Custom Next.js Server with WebSocket Support
 *
 * Wraps the standard Next.js server to handle WebSocket upgrade requests
 * for the voice API (/api/nexus/voice). All other requests pass through
 * to Next.js unchanged.
 *
 * Uses Bun.serve() with native WebSocket upgrade — the `ws` npm package's
 * handleUpgrade is incompatible with bun's node:http shim (close code 1006).
 * A lightweight shim (BunWebSocketShim) adapts bun's ServerWebSocket to
 * the event-based ws.WebSocket interface expected by ws-handler.ts.
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
// used by ws-handler.ts. Only implements the subset ws-handler actually uses.

type WsEventMap = {
  message: [(data: Buffer) => void]
  close: [(code: number, reason: Buffer) => void]
  error: [(error: Error) => void]
}

interface BunWsData {
  headers: Record<string, string>
  url: string
  shim: BunWebSocketShim | null
}

/**
 * Minimal EventEmitter-compatible wrapper around bun's ServerWebSocket.
 * Implements only the ws.WebSocket methods used by ws-handler.ts:
 * - on(event, handler) / removeAllListeners(event)
 * - send(data) / close(code, reason) / ping()
 * - readyState
 */
class BunWebSocketShim {
  private _listeners: { [K in keyof WsEventMap]?: Array<(...args: unknown[]) => void> } = {}
  private _bunWs: ServerWebSocket<BunWsData>

  constructor(bunWs: ServerWebSocket<BunWsData>) {
    this._bunWs = bunWs
  }

  get readyState(): number {
    return this._bunWs.readyState
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const key = event as keyof WsEventMap
    if (!this._listeners[key]) this._listeners[key] = []
    this._listeners[key]!.push(handler)
    return this
  }

  removeAllListeners(event: string): this {
    delete this._listeners[event as keyof WsEventMap]
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
  _emit(event: keyof WsEventMap, ...args: unknown[]): void {
    const handlers = this._listeners[event]
    if (!handlers) return
    for (const handler of handlers) {
      handler(...args)
    }
  }
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
          const origin = req.headers.get("origin")
          const host = req.headers.get("host")

          if (!isAllowedOrigin(origin, host)) {
            return new Response("Forbidden", { status: 403 })
          }

          // Pass request headers as data for auth extraction in ws-handler
          const data: BunWsData = {
            headers: Object.fromEntries(req.headers.entries()),
            url: req.url,
            shim: null,
          }

          const upgraded = server.upgrade(req, { data })
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 500 })
          }
          // Bun handles the 101 response
          return undefined as unknown as Response
        }
      }

      // All other requests → Next.js
      // Bun.serve's fetch receives a standard Request object.
      // Next.js's getRequestHandler expects (IncomingMessage, ServerResponse).
      // Use node:http createServer as a bridge.
      return new Promise<Response>((resolve) => {
        const fakeSocket = new PassThrough()
        Object.assign(fakeSocket, {
          remoteAddress: server.requestIP(req)?.address ?? "127.0.0.1",
          encrypted: url.protocol === "https:",
        })

        const nodeReq = new http.IncomingMessage(fakeSocket as unknown as Socket)
        nodeReq.url = url.pathname + url.search
        nodeReq.method = req.method
        nodeReq.headers = Object.fromEntries(req.headers.entries())

        const nodeRes = new http.ServerResponse(nodeReq)
        const chunks: Buffer[] = []

        const origWrite = nodeRes.write.bind(nodeRes)
        nodeRes.write = ((chunk: unknown, ...args: unknown[]) => {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
          return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args)
        }) as typeof nodeRes.write

        const origEnd = nodeRes.end.bind(nodeRes)
        nodeRes.end = ((chunk?: unknown, ...args: unknown[]) => {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
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
          resolve(new Response(Buffer.concat(chunks), {
            status: nodeRes.statusCode,
            headers,
          }))
          return (origEnd as (...a: unknown[]) => unknown)(chunk, ...args)
        }) as typeof nodeRes.end

        // Stream request body for POST/PUT etc
        if (req.body) {
          const reader = req.body.getReader()
          const pump = () => {
            reader.read().then(({ done, value }) => {
              if (done) { nodeReq.push(null); return }
              nodeReq.push(Buffer.from(value))
              pump()
            })
          }
          pump()
        } else {
          nodeReq.push(null)
        }

        nextHandler(nodeReq, nodeRes, parse(nodeReq.url || "/", true))
      })
    },

    websocket: {
      maxPayloadLength: WS_MAX_PAYLOAD,

      open(bunWs) {
        const wsData = bunWs.data
        const shim = new BunWebSocketShim(bunWs)
        wsData.shim = shim

        // Create a minimal IncomingMessage for auth cookie extraction
        const fakeSocket = new PassThrough()
        const req = new http.IncomingMessage(fakeSocket as unknown as Socket)
        req.url = wsData.url
        req.headers = wsData.headers

        // Handle voice connection using the existing ws-handler
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
        const wsData = bunWs.data
        const buf = typeof message === "string" ? Buffer.from(message) : Buffer.from(message)
        wsData.shim?._emit("message", buf)
      },

      close(bunWs, code, reason) {
        const wsData = bunWs.data
        wsData.shim?._emit("close", code, Buffer.from(reason || ""))
      },
    },
  })

  // Suppress unused variable — server is the running instance
  void server
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- Server startup errors must go to stderr
  console.error("Failed to start server:", err)
  process.exit(1)
})
