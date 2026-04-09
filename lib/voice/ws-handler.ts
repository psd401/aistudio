/**
 * Voice WebSocket Connection Handler
 *
 * Handles individual WebSocket connections for voice sessions.
 * Authenticates the client, creates a voice provider, and proxies
 * bidirectional audio between the client and the AI service.
 *
 * Architecture:
 *   Browser WebSocket → ws-handler → GeminiLiveProvider → Gemini Live API
 *                     ← ws-handler ← GeminiLiveProvider ← Gemini Live API
 *
 * Issue #872
 */

import type { IncomingMessage } from "node:http"
import type WebSocket from "ws"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { Settings } from "@/lib/settings-manager"
import { createVoiceProvider, isSupportedVoiceProvider } from "./provider-factory"
import { decode } from "@auth/core/jwt"
import { hasToolAccess } from "@/lib/db/drizzle/users"
import type {
  VoiceProvider,
  VoiceProviderConfig,
  VoiceClientMessage,
  VoiceServerMessage,
  VoiceProviderEvent,
} from "./types"

/** Max base64 audio data size per message: 128KB base64 ≈ 96KB PCM */
const MAX_AUDIO_DATA_LENGTH = 131_072
/** Connection timeout for provider.connect() — prevent indefinite hangs */
const PROVIDER_CONNECT_TIMEOUT_MS = 30_000
/** Min interval between audio messages per connection (ms) — rate limit */
const MIN_AUDIO_INTERVAL_MS = 20
/** ALB keepalive ping interval (must be < ALB idleTimeout of 300s) */
const PING_INTERVAL_MS = 240_000
/** WebSocket readyState OPEN constant (ws library value) */
const WS_OPEN = 1

/**
 * Authenticate an incoming WebSocket connection.
 *
 * Extracts the Auth.js session cookie and decrypts it using @auth/core/jwt.
 * Auth.js JWTs are encrypted (JWE with A256CBC-HS512), not signed,
 * so standard jwtVerify won't work — must use Auth.js decode.
 *
 * Handles chunked cookies (authjs.session-token.0, .1, etc.) for
 * large session tokens that exceed cookie size limits.
 *
 * Note: Cookie values are not URL-decoded. Auth.js does not URL-encode
 * session cookie values, so this is correct for the current implementation.
 */
async function authenticateWebSocket(req: IncomingMessage): Promise<{ userId: string; sub: string } | null> {
  const log = createLogger({ context: "voice-ws-auth" })

  try {
    const cookieHeader = req.headers.cookie || ""
    const cookies = Object.fromEntries(
      cookieHeader.split(";").map((c) => {
        const [key, ...vals] = c.trim().split("=")
        // Trim key and value to handle proxy/ALB whitespace injection
        return [key.trim(), vals.join("=").trim()]
      })
    )

    const cookieNames = ["__Secure-authjs.session-token", "authjs.session-token", "next-auth.session-token"]
    let sessionToken: string | undefined
    let cookieSalt: string | undefined

    for (const name of cookieNames) {
      if (cookies[name]) {
        sessionToken = cookies[name]
        cookieSalt = name
        break
      }
      // Chunked cookies: name.0, name.1, ... (Auth.js splits large tokens, typically 2-3 chunks)
      const chunks: string[] = []
      for (let i = 0; i < 20; i++) {
        const chunk = cookies[`${name}.${i}`]
        if (!chunk) break
        chunks.push(chunk)
      }
      if (chunks.length > 0) {
        sessionToken = chunks.join("")
        cookieSalt = name
        break
      }
    }

    if (!sessionToken || !cookieSalt) {
      log.warn("No session token found in WebSocket cookies")
      return null
    }

    const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
    if (!secret) {
      log.error("AUTH_SECRET not configured")
      return null
    }

    const payload = await decode({ token: sessionToken, salt: cookieSalt, secret })

    if (!payload?.sub) {
      log.warn("Session token missing sub claim")
      return null
    }

    return { userId: payload.sub, sub: payload.sub }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn("WebSocket authentication failed", { error: message })
    return null
  }
}

/**
 * Send a typed message to the client WebSocket.
 */
function sendToClient(ws: WebSocket, message: VoiceServerMessage): void {
  if (ws.readyState === WS_OPEN) {
    ws.send(JSON.stringify(message))
  }
}

/**
 * Validate that a parsed message has the expected shape for VoiceClientMessage.
 */
function isValidClientMessage(msg: unknown): msg is VoiceClientMessage {
  if (typeof msg !== "object" || msg === null) return false
  const obj = msg as Record<string, unknown>
  if (typeof obj.type !== "string") return false
  if (obj.type === "audio" && typeof obj.data !== "string") return false
  return true
}

/**
 * Forward a provider event to the client WebSocket as a typed message.
 */
function forwardProviderEvent(ws: WebSocket, event: VoiceProviderEvent): void {
  switch (event.type) {
    case "audio":
      sendToClient(ws, { type: "audio", data: event.data.toString("base64") })
      break
    case "transcript":
      sendToClient(ws, {
        type: "transcript",
        entry: {
          role: event.entry.role,
          text: event.entry.text,
          isFinal: event.entry.isFinal,
          timestamp: event.entry.timestamp.toISOString(),
        },
      })
      break
    case "state_change":
      sendToClient(ws, { type: "state", speaking: event.state.speaking })
      break
    case "error":
      sendToClient(ws, { type: "error", message: event.error.message })
      break
    case "session_ended":
      sendToClient(ws, { type: "session_ended", reason: event.reason })
      break
  }
}

/**
 * Handle a new WebSocket connection for voice sessions.
 *
 * Flow:
 * 1. Authenticate via Auth.js session cookie
 * 2. Check voice-mode tool access
 * 3. Get voice settings and create provider
 * 4. Register close/error handlers (BEFORE connect, to catch early disconnects)
 * 5. Connect to AI service (with timeout) and proxy audio bidirectionally
 */
export async function handleVoiceConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, context: "voice-ws" })
  const timer = startTimer("voice-session")

  let provider: VoiceProvider | null = null
  let pingInterval: ReturnType<typeof setInterval> | null = null
  let sessionEnded = false

  /** Clean up provider and timer — idempotent */
  function cleanup(status: string) {
    if (sessionEnded) return
    sessionEnded = true
    if (pingInterval) clearInterval(pingInterval)
    provider?.disconnect().catch((e: Error) =>
      log.warn("Provider disconnect failed during cleanup", { error: e.message })
    )
    timer({ status })
  }

  try {
    // Step 1: Authenticate
    log.info("New voice WebSocket connection")
    const auth = await authenticateWebSocket(req)
    if (!auth) {
      log.warn("Unauthorized voice connection attempt")
      sendToClient(ws, { type: "error", message: "Unauthorized" })
      ws.close(4001, "Unauthorized")
      timer({ status: "unauthorized" })
      return
    }

    log.info("Voice connection authenticated", { userId: sanitizeForLogging(auth.userId) })

    // Step 2: Check voice access (fail-closed on error)
    let hasAccess = false
    try {
      hasAccess = await hasToolAccess(auth.sub, "voice-mode")
    } catch {
      hasAccess = false
    }
    if (!hasAccess) {
      log.warn("User lacks voice-mode access", { userId: sanitizeForLogging(auth.userId) })
      sendToClient(ws, { type: "error", message: "Voice mode not enabled for this user" })
      ws.close(4003, "Forbidden")
      timer({ status: "forbidden" })
      return
    }

    // Step 3: Get voice settings and API key
    const [voiceSettings, googleApiKey] = await Promise.all([
      Settings.getVoice(),
      Settings.getGoogleAI(),
    ])

    if (!googleApiKey) {
      log.error("Google API key not configured")
      sendToClient(ws, { type: "error", message: "Voice provider not configured" })
      ws.close(4500, "Provider not configured")
      timer({ status: "error", reason: "missing_api_key" })
      return
    }

    if (!isSupportedVoiceProvider(voiceSettings.provider)) {
      log.error("Invalid voice provider configured", { provider: voiceSettings.provider })
      sendToClient(ws, { type: "error", message: "Voice provider not configured" })
      ws.close(4500, "Provider not configured")
      timer({ status: "error", reason: "invalid_provider" })
      return
    }
    provider = createVoiceProvider(voiceSettings.provider)

    // Step 4: Register close/error handlers BEFORE provider.connect() so cleanup
    // is guaranteed even if the WebSocket drops during the connect await.
    ws.on("close", (code, reason) => {
      log.info("Voice WebSocket closed", { code, reason: reason.toString() })
      cleanup("success")
    })

    ws.on("error", (error) => {
      log.error("Voice WebSocket error", { error: error.message })
      cleanup("error")
    })

    // Step 5: Connect to AI service with timeout
    const providerConfig: VoiceProviderConfig = {
      model: voiceSettings.model,
      language: voiceSettings.language,
      voiceName: voiceSettings.voiceName ?? undefined,
      apiKey: googleApiKey,
    }

    await Promise.race([
      provider.connect(providerConfig, (event) => forwardProviderEvent(ws, event)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Provider connection timeout")), PROVIDER_CONNECT_TIMEOUT_MS)
      ),
    ])

    // Signal ready to client
    sendToClient(ws, { type: "ready" })
    log.info("Voice session ready")

    // Step 6: Register message handler AFTER connect (clients must wait for "ready")
    let lastAudioTime = 0
    ws.on("message", (data) => {
      try {
        const parsed: unknown = JSON.parse(data.toString())
        if (!isValidClientMessage(parsed)) {
          log.warn("Invalid client message format")
          return
        }

        switch (parsed.type) {
          case "audio": {
            if (!provider?.isConnected()) break
            if (parsed.data.length > MAX_AUDIO_DATA_LENGTH) {
              log.warn("Audio data too large", { length: parsed.data.length })
              break
            }
            const now = Date.now()
            if (now - lastAudioTime < MIN_AUDIO_INTERVAL_MS) break
            lastAudioTime = now
            // Buffer.from silently ignores invalid base64 chars — acceptable for audio
            provider.sendAudio(Buffer.from(parsed.data, "base64"))
            break
          }

          case "disconnect": {
            log.info("Client requested disconnect")
            provider?.disconnect().catch((e: Error) =>
              log.warn("Error during client-requested disconnect", { error: e.message })
            )
            break
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log.error("Error processing client message", { error: errorMessage })
      }
    })

    // Step 7: Keepalive ping for ALB idle timeout (300s)
    pingInterval = setInterval(() => {
      if (ws.readyState === WS_OPEN) ws.ping()
      else if (pingInterval) clearInterval(pingInterval)
    }, PING_INTERVAL_MS)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error("Voice session setup failed", { error: message })
    sendToClient(ws, { type: "error", message: "Failed to establish voice session" })
    cleanup("error")
    ws.removeAllListeners("message")
    ws.removeAllListeners("close")
    ws.removeAllListeners("error")
    ws.close(4500, "Internal error")
  }
}
