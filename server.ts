/**
 * Custom Next.js Server with WebSocket Support
 *
 * Wraps the standard Next.js server to handle WebSocket upgrade requests
 * for the voice API (/api/nexus/voice). All other requests pass through
 * to Next.js unchanged.
 *
 * Usage:
 *   Development: bun run dev:ws (uses next dev + ws upgrade)
 *   Production:  node server.js (standalone build output)
 *
 * Issue #872
 */

import { createServer, type IncomingMessage } from "http"
import type { Duplex } from "stream"
import { WebSocketServer } from "ws"
import next from "next"
import { parse } from "url"

const VOICE_WS_PATH = "/api/nexus/voice"

const dev = process.env.NODE_ENV !== "production"
const hostname = process.env.HOSTNAME || "0.0.0.0"
const port = parseInt(process.env.PORT || "3000", 10)

async function main() {
  const app = next({ dev, hostname, port })
  const handle = app.getRequestHandler()

  await app.prepare()

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url || "/", true)
    handle(req, res, parsedUrl)
  })

  // WebSocket server with noServer mode — we handle upgrade manually
  const wss = new WebSocketServer({ noServer: true })

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = parse(request.url || "/")

    if (pathname === VOICE_WS_PATH) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request)
      })
    } else {
      // Let Next.js handle non-voice WebSocket upgrades (e.g. HMR in dev)
      // In dev mode, Next.js uses WebSocket for hot module replacement
      if (!dev) {
        socket.destroy()
      }
    }
  })

  wss.on("connection", async (ws, req) => {
    // Dynamic import to avoid loading voice module during build
    const { handleVoiceConnection } = await import("@/lib/voice/ws-handler")
    handleVoiceConnection(ws, req)
  })

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`)
    console.log(`> Voice WebSocket available at ws://${hostname}:${port}${VOICE_WS_PATH}`)
  })
}

main().catch((err) => {
  console.error("Failed to start server:", err)
  process.exit(1)
})
