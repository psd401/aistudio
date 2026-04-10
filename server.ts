/**
 * Custom Next.js Server with WebSocket Support
 *
 * Next.js runs on node:http (port 3000) — bun's shim handles HTTP fine.
 * Voice WebSocket runs on a separate Bun.serve() (port VOICE_WS_PORT) —
 * because the `ws` npm package's handleUpgrade is incompatible with bun.
 *
 * The client adapter connects to the voice WS port directly.
 * In production, ALB routes /api/nexus/voice to the WS port.
 *
 * Usage:
 *   Development: bun run dev:voice / bun run dev:local
 *   Docker:      CMD ["bun", "run", "server.ts"]
 *
 * Issue #872, #873
 */

import http, { createServer } from "node:http"
import { PassThrough } from "node:stream"
import type { Socket } from "node:net"
import type WebSocket from "ws"
import type { ServerWebSocket } from "bun"
import next from "next"
import { parse } from "node:url"

const VOICE_WS_PATH = "/api/nexus/voice"
const WS_MAX_PAYLOAD = 65536 // 64KB — must match lib/voice/constants.ts

const dev = process.env.NODE_ENV !== "production"
const hostname = process.env.HOSTNAME || "0.0.0.0"
const port = Number.parseInt(process.env.PORT || "3000", 10)
const voiceWsPort = Number.parseInt(process.env.VOICE_WS_PORT || "3001", 10)

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

  get readyState(): number { return this._bunWs.readyState }

  on(event: string, handler: (...args: unknown[]) => void): this {
    if (!this._listeners[event]) this._listeners[event] = []
    this._listeners[event].push(handler)
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
    try { this._bunWs.send(data); cb?.() }
    catch (err) { cb?.(err as Error) }
  }

  close(code?: number, reason?: string): void {
    try { this._bunWs.close(code, reason) } catch { /* already closed */ }
  }

  ping(): void {
    try { this._bunWs.ping() } catch { /* ignore */ }
  }

  _emit(event: string, ...args: unknown[]): void {
    const handlers = this._listeners[event]
    if (!handlers || handlers.length === 0) {
      if (event === "message" && args[0]) this._pendingMessages.push(args[0] as Buffer)
      return
    }
    for (const handler of handlers) handler(...args)
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

async function main() {
  const app = next({ dev, hostname, port })
  const handle = app.getRequestHandler()

  await app.prepare()

  // 1. Standard Next.js HTTP server on main port (node:http — works fine under bun)
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url || "/", true)
    handle(req, res, parsedUrl)
  })

  httpServer.listen(port, hostname)
  // eslint-disable-next-line no-console -- Server startup
  console.log(`[voice-server] Next.js on ${hostname}:${port}`)

  // 2. Separate Bun.serve() for voice WebSocket on sidecar port
  //    The ws npm package's handleUpgrade doesn't work under bun (close code 1006).
  //    Bun's native WebSocket upgrade works reliably.
  const wsServer = Bun.serve<BunWsData>({
    port: voiceWsPort,
    hostname,

    fetch(req, server) {
      const url = new URL(req.url)

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

      return new Response("Not found", { status: 404 })
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

  // eslint-disable-next-line no-console -- Server startup
  console.log(`[voice-server] Voice WebSocket on ${hostname}:${voiceWsPort}`)

  void wsServer
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- Server startup errors must go to stderr
  console.error("Failed to start server:", err)
  process.exit(1)
})
