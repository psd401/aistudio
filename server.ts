/**
 * Custom Next.js Server with WebSocket Support
 *
 * Wraps the standard Next.js server to handle WebSocket upgrade requests
 * for the voice API (/api/nexus/voice). All other requests pass through
 * to Next.js unchanged.
 *
 * Usage:
 *   Development: bun run dev:voice (uses next dev + ws upgrade)
 *   Production:  node voice-server.js (standalone build wrapper)
 *
 * Issue #872
 */

import { createServer, type IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer } from "ws"
import next from "next"
import { parse } from "node:url"

const VOICE_WS_PATH = "/api/nexus/voice"
// maxPayload: 64KB — PCM 16kHz 16-bit mono = 32KB/sec; generous 1-sec cap
const WS_MAX_PAYLOAD = 64 * 1024

const dev = process.env.NODE_ENV !== "production"
const hostname = process.env.HOSTNAME || "0.0.0.0"
const port = Number.parseInt(process.env.PORT || "3000", 10)

/**
 * Validate the Origin header on WebSocket upgrade to prevent CSWSH.
 * Returns true if the origin is allowed, false otherwise.
 */
function isAllowedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  // In development, allow all origins for local testing
  if (dev) return true
  // No origin header (e.g. server-to-server) — reject for browser safety
  if (!origin) return false

  const allowedOrigins: string[] = []
  if (process.env.ALLOWED_ORIGINS) {
    allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()))
  }
  const appUrl = process.env.NEXTAUTH_URL || process.env.APP_URL
  if (appUrl) allowedOrigins.push(appUrl.replace(/\/+$/, ""))

  // If no allowed origins configured, fall back to same-origin check
  if (allowedOrigins.length === 0) {
    const host = request.headers.host
    if (!host) return false
    const protocol = request.headers["x-forwarded-proto"] === "https" ? "https" : "http"
    return origin === `${protocol}://${host}`
  }

  return allowedOrigins.includes(origin)
}

async function main() {
  const app = next({ dev, hostname, port })
  const handle = app.getRequestHandler()

  await app.prepare()

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url || "/", true)
    handle(req, res, parsedUrl)
  })

  // WebSocket server with noServer mode and payload size limit
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD })

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = parse(request.url || "/")

    if (pathname === VOICE_WS_PATH) {
      // H3: Validate origin to prevent cross-site WebSocket hijacking
      if (!isAllowedOrigin(request)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n")
        socket.destroy()
        return
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request)
      })
    } else {
      // Let Next.js handle non-voice WebSocket upgrades (e.g. HMR in dev)
      if (!dev) {
        socket.destroy()
      }
    }
  })

  wss.on("connection", async (ws, req) => {
    try {
      // Dynamic import to avoid loading voice module during build
      const { handleVoiceConnection } = await import("@/lib/voice/ws-handler")
      // H1: Await the promise so unhandled errors propagate
      await handleVoiceConnection(ws, req)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console -- Outside Next.js runtime
      console.error("[voice-server] Connection error:", message)
      try { ws.close(4500, "Internal error") } catch { /* already closed */ }
    }
  })

  server.listen(port, hostname)
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- Server startup errors must go to stderr
  console.error("Failed to start server:", err)
  process.exit(1)
})
