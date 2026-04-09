/**
 * Production Voice Server Wrapper
 *
 * Wraps the Next.js standalone server to add WebSocket support for voice.
 * This script intercepts the HTTP server creation to attach a WebSocket
 * upgrade handler for /api/nexus/voice, then delegates to the standard
 * Next.js standalone server.
 *
 * Usage: CMD ["node", "voice-server.js"] in Dockerfile
 *
 * Issue #872
 */

/* eslint-disable no-undef, @typescript-eslint/no-require-imports, unicorn/prefer-node-protocol -- CJS script running outside Next.js runtime */
const http = require('http')
const { WebSocketServer } = require('ws')
const { parse } = require('url')

const VOICE_WS_PATH = '/api/nexus/voice'

// Store reference for WebSocket setup
let wss = null

/**
 * Intercept http.createServer to attach WebSocket upgrade handling.
 *
 * Next.js standalone server.js calls http.createServer (or net.createServer)
 * internally via startServer(). We intercept to get a reference to the
 * HTTP server and attach our WebSocket upgrade handler.
 */
const originalCreateServer = http.createServer.bind(http)

http.createServer = function (...args) {
  const server = originalCreateServer(...args)

  // Only set up WebSocket once (startServer may create multiple servers)
  if (!wss) {
    // maxPayload: 64KB — PCM 16kHz 16-bit mono = 32KB/sec; generous 1-sec cap
    wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })

    server.on('upgrade', (request, socket, head) => {
      const { pathname } = parse(request.url || '/')

      if (pathname === VOICE_WS_PATH) {
        // Validate origin to prevent cross-site WebSocket hijacking (CSWSH)
        // Reject requests with no Origin header — browser WS requests always include it
        const origin = request.headers.origin
        if (!origin) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }

        const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
        const appUrl = process.env.NEXTAUTH_URL || process.env.APP_URL
        if (appUrl) allowedOrigins.push(appUrl.replace(/\/+$/, ''))

        if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request)
        })
      }
      // Don't destroy socket for non-voice upgrades — Next.js may handle them
    })

    wss.on('connection', async (ws, req) => {
      try {
        // Import the voice handler from the Next.js server bundle.
        // If the module is unavailable, hard-fail — do NOT fall back to an
        // inline handler, as that would bypass hasToolAccess authorization.
        const { handleVoiceConnection } = require('./.next/server/lib/voice/ws-handler')
        await handleVoiceConnection(ws, req).catch((err) => {
          console.error('[voice-server] Voice connection error:', err.message) // eslint-disable-line no-console
          try { ws.close(4500, 'Internal error') } catch { /* already closed */ }
        })
      } catch (importError) {
        console.error('[voice-server] FATAL: ws-handler module not found in bundle:', importError.message) // eslint-disable-line no-console
        ws.send(JSON.stringify({ type: 'error', message: 'Voice service unavailable' }))
        ws.close(4500, 'Service unavailable')
      }
    })

    console.log(`[voice-server] WebSocket handler registered for ${VOICE_WS_PATH}`) // eslint-disable-line no-console
  }

  return server
}

// Now load and run the original Next.js standalone server
// This triggers startServer() which will call our patched http.createServer
require('./server.js')
