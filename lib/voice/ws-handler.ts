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
import { createVoiceProvider } from "./provider-factory"
import type {
  VoiceProvider,
  VoiceProviderConfig,
  VoiceClientMessage,
  VoiceServerMessage,
} from "./types"

/** Max base64 audio data size per message: 128KB base64 ≈ 96KB PCM */
const MAX_AUDIO_DATA_LENGTH = 131_072

/**
 * Authenticate an incoming WebSocket connection.
 *
 * Extracts the Auth.js session cookie and decrypts it using @auth/core/jwt.
 * Auth.js JWTs are encrypted (JWE with A256CBC-HS512), not signed,
 * so standard jwtVerify won't work — must use Auth.js decode.
 *
 * Handles chunked cookies (authjs.session-token.0, .1, etc.) for
 * large session tokens that exceed cookie size limits.
 */
async function authenticateWebSocket(req: IncomingMessage): Promise<{ userId: string; sub: string } | null> {
  const log = createLogger({ context: "voice-ws-auth" })

  try {
    const cookieHeader = req.headers.cookie || ""
    const cookies = Object.fromEntries(
      cookieHeader.split(";").map((c) => {
        const [key, ...vals] = c.trim().split("=")
        return [key, vals.join("=")]
      })
    )

    // Determine cookie name and extract token (handles __Secure- prefix and chunked cookies)
    const cookieNames = ["__Secure-authjs.session-token", "authjs.session-token", "next-auth.session-token"]
    let sessionToken: string | undefined
    let cookieSalt: string | undefined

    for (const name of cookieNames) {
      // Check for single cookie
      if (cookies[name]) {
        sessionToken = cookies[name]
        cookieSalt = name
        break
      }
      // Check for chunked cookies (name.0, name.1, ...)
      const chunks: string[] = []
      for (let i = 0; ; i++) {
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

    // Decrypt the Auth.js JWT session token
    // Auth.js encrypts session cookies with A256CBC-HS512 using AUTH_SECRET
    const { decode } = await import("@auth/core/jwt")
    const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
    if (!secret) {
      log.error("AUTH_SECRET not configured")
      return null
    }

    const payload = await decode({
      token: sessionToken,
      salt: cookieSalt,
      secret,
    })

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
 * Check if the user has access to voice mode.
 *
 * Uses the same hasToolAccess pattern as the rest of the application.
 * The DB-level hasToolAccess takes cognitoSub directly.
 */
async function checkVoiceAccess(sub: string): Promise<boolean> {
  const log = createLogger({ context: "voice-ws-access" })

  try {
    const { hasToolAccess } = await import("@/lib/db/drizzle/users")
    return await hasToolAccess(sub, "voice-mode")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error("Error checking voice access", { error: message })
    return false
  }
}

/**
 * Send a typed message to the client WebSocket.
 * Uses numeric readyState comparison for reliability.
 */
function sendToClient(ws: WebSocket, message: VoiceServerMessage): void {
  // WebSocket.OPEN === 1; compare numerically to avoid prototype lookup issues
  if (ws.readyState === 1) {
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
function forwardProviderEvent(ws: WebSocket, event: import("./types").VoiceProviderEvent): void {
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
 * 4. Connect to AI service and proxy audio bidirectionally
 */
export async function handleVoiceConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, context: "voice-ws" })
  const timer = startTimer("voice-session")

  let provider: VoiceProvider | null = null

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

    // Step 2: Check voice access
    const hasAccess = await checkVoiceAccess(auth.sub)
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

    // Step 4: Validate and create provider
    const { isSupportedVoiceProvider } = await import("./provider-factory")
    if (!isSupportedVoiceProvider(voiceSettings.provider)) {
      log.error("Invalid voice provider configured", { provider: voiceSettings.provider })
      sendToClient(ws, { type: "error", message: "Voice provider not configured" })
      ws.close(4500, "Provider not configured")
      timer({ status: "error", reason: "invalid_provider" })
      return
    }
    provider = createVoiceProvider(voiceSettings.provider)

    // Step 5: Handle incoming messages from client
    ws.on("message", (data) => {
      try {
        const parsed: unknown = JSON.parse(data.toString())
        if (!isValidClientMessage(parsed)) {
          log.warn("Invalid client message format")
          return
        }
        const message = parsed

        switch (message.type) {
          case "audio": {
            if (provider?.isConnected()) {
              if (message.data.length > MAX_AUDIO_DATA_LENGTH) {
                log.warn("Audio data too large", { length: message.data.length })
                break
              }
              const audioBuffer = Buffer.from(message.data, "base64")
              provider.sendAudio(audioBuffer)
            }
            break
          }

          case "disconnect": {
            log.info("Client requested disconnect")
            void provider?.disconnect().catch((e: Error) =>
              log.warn("Error during client-requested disconnect", { error: e.message })
            )
            break
          }

          default: {
            log.warn("Unknown client message type", {
              type: (message as Record<string, unknown>).type,
            })
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log.error("Error processing client message", { error: errorMessage })
      }
    })

    // Step 6: Connect to AI service with event forwarding
    const providerConfig: VoiceProviderConfig = {
      model: voiceSettings.model,
      language: voiceSettings.language,
      voiceName: voiceSettings.voiceName ?? undefined,
      apiKey: googleApiKey,
    }

    await provider.connect(providerConfig, (event) => forwardProviderEvent(ws, event))

    // Signal ready to client
    sendToClient(ws, { type: "ready" })
    log.info("Voice session ready")

    // Step 7: Clean up on close
    ws.on("close", (code, reason) => {
      log.info("Voice WebSocket closed", { code, reason: reason.toString() })
      void provider?.disconnect().catch((e: Error) =>
        log.warn("Error during close cleanup", { error: e.message })
      )
      timer({ status: "success" })
    })

    ws.on("error", (error) => {
      log.error("Voice WebSocket error", { error: error.message })
      void provider?.disconnect().catch((e: Error) =>
        log.warn("Error during error cleanup", { error: e.message })
      )
      timer({ status: "error" })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error("Voice session setup failed", { error: message })
    sendToClient(ws, { type: "error", message: "Failed to establish voice session" })
    void provider?.disconnect().catch(() => { /* cleanup best-effort */ })
    ws.close(4500, "Internal error")
    timer({ status: "error" })
  }
}
