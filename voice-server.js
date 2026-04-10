/**
 * Production Voice Server Wrapper
 *
 * Uses Bun.serve() with native WebSocket support to serve the Next.js
 * standalone build AND handle voice WebSocket upgrades on the same port.
 *
 * The `ws` npm package is incompatible with bun's HTTP upgrade handling
 * (handleUpgrade causes close code 1006). This wrapper uses bun's native
 * WebSocket with BunWebSocketShim for ws-handler compatibility.
 *
 * HTTP bridge uses ReadableStream for SSR streaming compatibility.
 *
 * IMPORTANT: If the WS handler module fails to load, the app continues
 * serving HTTP normally — voice just won't work.
 *
 * Usage: CMD ["bun", "run", "voice-server.js"] in Dockerfile
 *
 * Issue #872, #873
 */

/* eslint-disable no-undef, @typescript-eslint/no-require-imports, unicorn/prefer-node-protocol -- CJS script outside Next.js runtime */
const http = require('http')
const { PassThrough } = require('stream')

const VOICE_WS_PATH = '/api/nexus/voice'
const WS_MAX_PAYLOAD = 65536 // 64KB — must match lib/voice/constants.ts

// WS handler module path in Next.js standalone output.
const WS_HANDLER_PATH = './.next/server/lib/voice/ws-handler'

let handleVoiceConnection = null

try {
  const mod = require(WS_HANDLER_PATH)
  if (typeof mod.handleVoiceConnection === 'function') {
    handleVoiceConnection = mod.handleVoiceConnection
    console.log(`[voice-server] Voice WebSocket handler loaded`) // eslint-disable-line no-console
  } else {
    console.error(`[voice-server] ws-handler loaded but handleVoiceConnection is not a function`) // eslint-disable-line no-console
  }
} catch (err) {
  console.error(`[voice-server] Voice WebSocket disabled: ${err.message}`) // eslint-disable-line no-console
}

/**
 * Validate origin to prevent CSWSH. Production only — no dev bypass.
 */
function isOriginAllowed(origin, host) {
  if (!origin) return false

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
  const appUrl = process.env.NEXTAUTH_URL || process.env.APP_URL
  if (appUrl) allowedOrigins.push(appUrl.replace(/\/+$/, ''))

  if (allowedOrigins.length > 0) {
    return allowedOrigins.includes(origin)
  }

  const proto = 'https' // Production behind ALB = always HTTPS
  return !!host && origin === `${proto}://${host}`
}

/**
 * Lightweight shim: adapts bun's ServerWebSocket to ws.WebSocket interface.
 * Buffers messages arriving before listeners are registered (race condition fix).
 */
class BunWebSocketShim {
  constructor(bunWs) {
    this._bunWs = bunWs
    this._listeners = {}
    this._pendingMessages = []
  }

  get readyState() { return this._bunWs.readyState }

  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = []
    this._listeners[event].push(handler)
    // Drain buffered messages when message listener is first registered
    if (event === 'message' && this._pendingMessages.length > 0) {
      const queued = this._pendingMessages.splice(0)
      for (const msg of queued) handler(msg)
    }
    return this
  }

  removeAllListeners(event) {
    delete this._listeners[event]
    return this
  }

  send(data, cb) {
    try { this._bunWs.send(data); cb?.() }
    catch (err) { cb?.(err) }
  }

  close(code, reason) {
    try { this._bunWs.close(code, reason) } catch { /* already closed */ }
  }

  ping() {
    try { this._bunWs.ping() } catch { /* ignore */ }
  }

  _emit(event, ...args) {
    const handlers = this._listeners[event]
    if (!handlers || handlers.length === 0) {
      if (event === 'message' && args[0]) {
        this._pendingMessages.push(args[0])
      }
      return
    }
    for (const handler of handlers) handler(...args)
  }
}

/**
 * Streaming HTTP bridge: converts Bun Request/Response to Next.js
 * IncomingMessage/ServerResponse with ReadableStream body.
 */
function handleNextRequest(req, server, nextHandler) {
  return new Promise((resolve) => {
    const url = new URL(req.url)
    const fakeSocket = new PassThrough()
    Object.assign(fakeSocket, {
      remoteAddress: server.requestIP(req)?.address ?? '127.0.0.1',
      encrypted: false,
    })

    const nodeReq = new http.IncomingMessage(fakeSocket)
    nodeReq.url = url.pathname + url.search
    nodeReq.method = req.method
    nodeReq.headers = Object.fromEntries(req.headers.entries())

    const nodeRes = new http.ServerResponse(nodeReq)

    let streamController
    let headersSent = false
    let resolved = false

    const body = new ReadableStream({
      start(controller) { streamController = controller },
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
    nodeRes.writeHead = (...args) => {
      const result = origWriteHead(...args)
      sendHeaders()
      return result
    }

    const origWrite = nodeRes.write.bind(nodeRes)
    nodeRes.write = (chunk, ...args) => {
      sendHeaders()
      if (chunk) {
        streamController.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      return origWrite(chunk, ...args)
    }

    const origEnd = nodeRes.end.bind(nodeRes)
    nodeRes.end = (chunk, ...args) => {
      if (chunk) {
        sendHeaders()
        streamController.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      streamController.close()
      if (!resolved) sendHeaders()
      return origEnd(chunk, ...args)
    }

    // Stream request body
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

    nextHandler(nodeReq, nodeRes)
  })
}

// ─── Start Server ─────────────────────────────────────────────────────────────

const serverHostname = process.env.HOSTNAME || '0.0.0.0'
const serverPort = Number.parseInt(process.env.PORT || '3000', 10)

let nextHandler = null
let captured = false

// One-shot monkey-patch: capture Next.js request handler from standalone server.js
http.createServer = function (handler) {
  if (!captured) {
    captured = true
    nextHandler = handler
  }
  // Return fake server — Bun.serve() handles actual listening
  return {
    listen: () => {
      console.log('[voice-server] Captured Next.js handler, starting Bun.serve()') // eslint-disable-line no-console
      startBunServer()
    },
    on: () => {},
    once: () => {},
    address: () => ({ port: serverPort, address: serverHostname }),
  }
}

function startBunServer() {
  Bun.serve({
    port: serverPort,
    hostname: serverHostname,

    async fetch(req, server) {
      const url = new URL(req.url)

      // Voice WebSocket upgrade
      if (url.pathname === VOICE_WS_PATH && handleVoiceConnection) {
        const upgradeHeader = req.headers.get('upgrade')
        if (upgradeHeader?.toLowerCase() === 'websocket') {
          if (!isOriginAllowed(req.headers.get('origin'), req.headers.get('host'))) {
            return new Response('Forbidden', { status: 403 })
          }

          const data = {
            headers: Object.fromEntries(req.headers.entries()),
            url: req.url,
            shim: null,
          }

          if (server.upgrade(req, { data })) {
            return undefined
          }
          return new Response('WebSocket upgrade failed', { status: 500 })
        }
      }

      // All other requests → Next.js via streaming bridge
      return handleNextRequest(req, server, nextHandler)
    },

    websocket: {
      maxPayloadLength: WS_MAX_PAYLOAD,

      open(bunWs) {
        const wsData = bunWs.data
        const shim = new BunWebSocketShim(bunWs)
        wsData.shim = shim

        const fakeSocket = new PassThrough()
        const req = new http.IncomingMessage(fakeSocket)
        req.url = wsData.url
        req.headers = wsData.headers

        handleVoiceConnection(shim, req).catch((error) => {
          console.error('[voice-server] Connection error:', error.message) // eslint-disable-line no-console
          try { shim.close(4500, 'Internal error') } catch { /* already closed */ }
        })
      },

      message(bunWs, message) {
        const buf = typeof message === 'string' ? Buffer.from(message) : Buffer.from(message)
        bunWs.data.shim?._emit('message', buf)
      },

      close(bunWs, code, reason) {
        bunWs.data.shim?._emit('close', code, Buffer.from(reason || ''))
      },
    },
  })

  console.log(`[voice-server] Listening on ${serverHostname}:${serverPort}`) // eslint-disable-line no-console
}

// Load Next.js standalone server — triggers the monkey-patched createServer
require('./server.js')
