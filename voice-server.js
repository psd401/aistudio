/**
 * Production Voice Server Wrapper
 *
 * Wraps the Next.js standalone server to add WebSocket support for voice.
 * This script intercepts the HTTP server creation to attach a WebSocket
 * upgrade handler for /api/nexus/voice, then delegates to the standard
 * Next.js standalone server.
 *
 * Architecture note: This monkey-patch approach is the de-facto standard for
 * adding WebSocket to Next.js App Router with `output: standalone` on ECS.
 * Alternatives (custom server, instrumentation.ts, next-ws) are either
 * incompatible with standalone output or broken in production. See research
 * in PR #884 for details.
 *
 * IMPORTANT: If the WS handler module fails to load, the app continues
 * serving HTTP normally — voice just won't work. This ensures a build
 * output path change in Next.js doesn't take down the entire app.
 *
 * Usage: CMD ["node", "voice-server.js"] in Dockerfile
 *
 * Issue #872
 */

/* eslint-disable no-undef, @typescript-eslint/no-require-imports, unicorn/prefer-node-protocol -- CJS script outside Next.js runtime */
const http = require('http')
const { WebSocketServer } = require('ws')
const { parse } = require('url')

const VOICE_WS_PATH = '/api/nexus/voice'

// WS handler module path in Next.js standalone output.
// This is a build output path, not a public API — if Next.js changes the
// standalone structure, update this path. The app will log a clear error
// and continue serving HTTP if this path becomes stale.
const WS_HANDLER_PATH = './.next/server/lib/voice/ws-handler'

let wss = null
let wsHandlerAvailable = false

/**
 * Try to load the voice WS handler module at startup.
 * If it fails, voice is disabled but the app continues running.
 */
function loadWsHandler() {
  try {
    const mod = require(WS_HANDLER_PATH)
    if (typeof mod.handleVoiceConnection === 'function') {
      wsHandlerAvailable = true
      return mod.handleVoiceConnection
    }
    console.error(`[voice-server] ws-handler loaded but handleVoiceConnection is not a function`) // eslint-disable-line no-console
    return null
  } catch (err) {
    console.error(`[voice-server] Voice WebSocket disabled: ws-handler not found at ${WS_HANDLER_PATH}`) // eslint-disable-line no-console
    console.error(`[voice-server] Expected path may have changed with Next.js upgrade. Error: ${err.message}`) // eslint-disable-line no-console
    return null
  }
}

const handleVoiceConnection = loadWsHandler()

/**
 * Validate origin to prevent cross-site WebSocket hijacking (CSWSH).
 * Logic mirrors server.ts:isAllowedOrigin() — duplicated because this
 * file is CJS (standalone) and cannot import from the ESM server.ts.
 *
 * INTENTIONAL DIFFERENCE: server.ts (dev) bypasses origin checks for
 * local testing. This file (production only) does NOT bypass.
 * Both use the same same-origin fallback when no origins are configured.
 */
function isOriginAllowed(request) {
  const origin = request.headers.origin
  // Browser WS requests always include Origin — missing = non-browser
  if (!origin) return false

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
  const appUrl = process.env.NEXTAUTH_URL || process.env.APP_URL
  if (appUrl) allowedOrigins.push(appUrl.replace(/\/+$/, ''))

  if (allowedOrigins.length > 0) {
    return allowedOrigins.includes(origin)
  }

  // No explicit origins — fall back to same-origin check
  const host = request.headers.host
  // In production behind ALB, x-forwarded-proto is always https
  const proto = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  return !!host && origin === `${proto}://${host}`
}

/**
 * Intercept http.createServer to attach WebSocket upgrade handling.
 * Next.js standalone server.js calls http.createServer internally.
 */
const originalCreateServer = http.createServer.bind(http)

http.createServer = function (...args) {
  const server = originalCreateServer(...args)

  if (!wss) {
    // maxPayload must match WS_MAX_PAYLOAD in lib/voice/constants.ts (64KB)
    wss = new WebSocketServer({ noServer: true, maxPayload: 65536 })

    server.on('upgrade', (request, socket, head) => {
      const { pathname } = parse(request.url || '/')

      if (pathname === VOICE_WS_PATH) {
        if (!wsHandlerAvailable) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
          socket.destroy()
          return
        }

        if (!isOriginAllowed(request)) {
          console.warn(`[voice-server] Origin rejected: ${request.headers.origin || '(none)'}`) // eslint-disable-line no-console
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request)
        })
      }
    })

    wss.on('connection', async (ws, req) => {
      try {
        await handleVoiceConnection(ws, req)
      } catch (err) {
        console.error('[voice-server] Voice connection error:', err.message) // eslint-disable-line no-console
        try { ws.close(4500, 'Internal error') } catch { /* already closed */ }
      }
    })

    if (wsHandlerAvailable) {
      console.log(`[voice-server] WebSocket handler registered for ${VOICE_WS_PATH}`) // eslint-disable-line no-console
    } else {
      console.warn(`[voice-server] WebSocket handler NOT available — voice disabled, HTTP serving normally`) // eslint-disable-line no-console
    }
  }

  return server
}

// Load and run the Next.js standalone server
require('./server.js')
