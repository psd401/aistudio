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
// Must match WS_MAX_PAYLOAD in lib/voice/constants.ts and voice-server.js
const WS_MAX_PAYLOAD = 65536 // 64KB

// Atrium collaboration (#1051). Yjs sync frames (initial document state) can far
// exceed the 64KB voice cap, so collab gets its own WS server with a larger
// payload limit. Kept in sync with voice-server.js (prod).
// Dedicated path OUTSIDE /api/content/* — Next's dev server intercepts upgrades
// in the /api/content/* namespace (where the collab-token + agent-bridge routes
// live), so the WS transport gets its own top-level path.
const COLLAB_WS_PATH = "/api/atrium-collab"
const COLLAB_MAX_PAYLOAD = 16 * 1024 * 1024 // 16MB

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

  // If no allowed origins configured, fall back to same-origin check.
  // Protocol may be "http" for local dev without HTTPS — this is intentional
  // to allow dev:voice to work without TLS. In production, ALB always sets
  // x-forwarded-proto: https so the check enforces HTTPS origins.
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

  // Pre-load the collab handler at startup (NOT lazily inside the connection
  // handler). WebsocketProvider sends its first sync message immediately on open;
  // a `await import()` in the connection path would delay attaching the
  // message listener past those first frames, dropping them so the protocol never
  // starts. Pre-loading lets us call the handler synchronously on 'connection'.
  // Importing the collab module runs its init, which registers a process-global
  // SIGTERM flush hook (globalThis.__atriumCollabShutdown). Next.js's
  // instrumentation.ts SIGTERM/SIGINT handler (loaded by app.prepare() above)
  // awaits that hook BEFORE closing the DB pool, so pending (debounced) collab room
  // state is flushed on shutdown. No SIGTERM handler is registered here — a second
  // handler would race instrumentation's process.exit(0) and could kill the
  // in-flight collab writes.
  const { handleCollabConnection } = await import("@/lib/content/collab/collab-server")

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url || "/", true)
    handle(req, res, parsedUrl)
  })

  // WebSocket server with noServer mode and payload size limit
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD })
  // Separate WS server for Atrium collab (larger payload for Yjs sync frames).
  const collabWss = new WebSocketServer({ noServer: true, maxPayload: COLLAB_MAX_PAYLOAD })

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
    } else if (pathname === COLLAB_WS_PATH || (pathname?.startsWith(`${COLLAB_WS_PATH}/`) ?? false)) {
      // WebsocketProvider connects to `${url}/<docName>`, so match the path as a
      // prefix. The document name is extracted from the URL path segment in
      // handleCollabConnection — not from the Yjs protocol message.
      if (!isAllowedOrigin(request)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n")
        socket.destroy()
        return
      }
      collabWss.handleUpgrade(request, socket, head, (ws) => {
        collabWss.emit("connection", ws, request)
      })
      return
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

  collabWss.on("connection", (ws, req) => {
    // Synchronous call — getServer().handleConnection runs in this same tick and
    // attaches Hocuspocus's message listener before the client's first frame is
    // processed (see the pre-load note above).
    Promise.resolve(handleCollabConnection(ws, req)).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console -- Outside Next.js runtime
      console.error("[atrium-collab] Connection error:", message)
      try { ws.close(4500, "Internal error") } catch { /* already closed */ }
    })
  })

  server.listen(port, hostname)
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- Server startup errors must go to stderr
  console.error("Failed to start server:", err)
  process.exit(1)
})
