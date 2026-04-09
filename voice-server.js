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

/* eslint-disable no-undef, no-console, @typescript-eslint/no-require-imports, unicorn/prefer-node-protocol */
const http = require('http')
const { WebSocketServer } = require('ws')
const { parse } = require('url')
const crypto = require('crypto')

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
    wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (request, socket, head) => {
      const { pathname } = parse(request.url || '/')

      if (pathname === VOICE_WS_PATH) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request)
        })
      }
      // Don't destroy socket for non-voice upgrades — Next.js may handle them
    })

    wss.on('connection', async (ws, req) => {
      try {
        // Dynamic import of the voice handler from Next.js server bundle
        // The handler is compiled into the .next/server/ directory during build
        const { handleVoiceConnection } = require('./.next/server/lib/voice/ws-handler')
        handleVoiceConnection(ws, req)
      } catch (importError) {
        // If the handler isn't available in the bundle, use inline auth + proxy
        console.error('[voice-server] Failed to load ws-handler from bundle, using inline handler:', importError.message)
        handleVoiceConnectionInline(ws, req)
      }
    })

    console.log(`[voice-server] WebSocket handler registered for ${VOICE_WS_PATH}`)
  }

  return server
}

/**
 * Inline fallback handler for when the bundled ws-handler is not available.
 * Performs basic auth check and sets up a minimal voice proxy.
 */
async function handleVoiceConnectionInline(ws, req) {
  const requestId = crypto.randomUUID()
  console.log(`[voice-server] [${requestId}] New voice connection (inline handler)`)

  try {
    // Extract session token from cookies
    const cookieHeader = req.headers.cookie || ''
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map((c) => {
        const [key, ...vals] = c.trim().split('=')
        return [key, vals.join('=')]
      })
    )

    const sessionToken =
      cookies['__Secure-authjs.session-token'] ||
      cookies['authjs.session-token'] ||
      cookies['next-auth.session-token']

    if (!sessionToken) {
      console.warn(`[voice-server] [${requestId}] No session token found`)
      ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }))
      ws.close(4001, 'Unauthorized')
      return
    }

    // Verify JWT using jose (available in Node.js 22)
    const { jwtVerify } = await import('jose')
    const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
    if (!secret) {
      console.error(`[voice-server] [${requestId}] AUTH_SECRET not configured`)
      ws.send(JSON.stringify({ type: 'error', message: 'Server misconfigured' }))
      ws.close(4500, 'Server error')
      return
    }

    const secretKey = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(sessionToken, secretKey)

    if (!payload.sub) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid session' }))
      ws.close(4001, 'Unauthorized')
      return
    }

    console.log(`[voice-server] [${requestId}] Authenticated user: ${payload.sub}`)

    // For the inline handler, we set up a basic Gemini Live proxy
    // The full handler with tool access checks runs when the bundled version is available
    const { GoogleGenAI, Modality } = await import('@google/genai')

    const apiKey = process.env.GOOGLE_API_KEY
    if (!apiKey) {
      ws.send(JSON.stringify({ type: 'error', message: 'Voice provider not configured' }))
      ws.close(4500, 'Provider not configured')
      return
    }

    const ai = new GoogleGenAI({ apiKey })
    const model = process.env.VOICE_MODEL || 'gemini-2.0-flash-live-001'

    const session = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {
          ws.send(JSON.stringify({ type: 'ready' }))
        },
        onmessage: (message) => {
          const content = message.serverContent
          if (!content) return

          // Forward audio
          if (content.modelTurn?.parts) {
            for (const part of content.modelTurn.parts) {
              if (part.inlineData?.data) {
                ws.send(JSON.stringify({ type: 'audio', data: part.inlineData.data }))
              }
            }
          }

          // Forward transcripts
          if (content.inputTranscription?.text) {
            ws.send(JSON.stringify({
              type: 'transcript',
              entry: { role: 'user', text: content.inputTranscription.text, isFinal: true, timestamp: new Date().toISOString() }
            }))
          }
          if (content.outputTranscription?.text) {
            ws.send(JSON.stringify({
              type: 'transcript',
              entry: { role: 'assistant', text: content.outputTranscription.text, isFinal: true, timestamp: new Date().toISOString() }
            }))
          }

          // Forward state
          if (content.turnComplete) {
            ws.send(JSON.stringify({ type: 'state', speaking: 'none' }))
          }
          if (content.interrupted) {
            ws.send(JSON.stringify({ type: 'state', speaking: 'user' }))
          }
        },
        onerror: (error) => {
          console.error(`[voice-server] [${requestId}] Gemini error:`, error.message)
          ws.send(JSON.stringify({ type: 'error', message: 'Voice service error' }))
        },
        onclose: () => {
          ws.send(JSON.stringify({ type: 'session_ended', reason: 'finished' }))
          ws.close()
        },
      },
    })

    // Forward audio from client to Gemini
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'audio' && msg.data) {
          const audioBuffer = Buffer.from(msg.data, 'base64')
          const audioBlob = new Blob([audioBuffer], { type: 'audio/pcm;rate=16000' })
          session.sendRealtimeInput({ audio: audioBlob })
        } else if (msg.type === 'disconnect') {
          session.conn.close()
        }
      } catch (err) {
        console.error(`[voice-server] [${requestId}] Message error:`, err.message)
      }
    })

    ws.on('close', () => {
      console.log(`[voice-server] [${requestId}] Connection closed`)
      try { session.conn.close() } catch { /* ignore */ }
    })

    ws.on('error', (err) => {
      console.error(`[voice-server] [${requestId}] WebSocket error:`, err.message)
      try { session.conn.close() } catch { /* ignore */ }
    })
  } catch (error) {
    console.error(`[voice-server] [${requestId}] Setup error:`, error.message || error)
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to establish voice session' }))
    ws.close(4500, 'Internal error')
  }
}

// Now load and run the original Next.js standalone server
// This triggers startServer() which will call our patched http.createServer
require('./server.js')
