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
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { Settings } from "@/lib/settings-manager"
import { createVoiceProvider } from "./provider-factory"
import type {
  VoiceProvider,
  VoiceProviderConfig,
  VoiceClientMessage,
  VoiceServerMessage,
} from "./types"

/**
 * Authenticate an incoming WebSocket connection.
 *
 * Extracts the session token from the cookie header and validates it.
 * Returns the user ID if valid, null otherwise.
 *
 * Note: We can't use getServerSession() directly because WebSocket upgrade
 * requests don't go through the Next.js request pipeline. Instead we
 * verify the NextAuth session token from the cookie.
 */
async function authenticateWebSocket(req: IncomingMessage): Promise<{ userId: string; sub: string } | null> {
  const log = createLogger({ context: "voice-ws-auth" })

  try {
    // Extract session token from cookies
    const cookieHeader = req.headers.cookie || ""
    const cookies = Object.fromEntries(
      cookieHeader.split(";").map((c) => {
        const [key, ...vals] = c.trim().split("=")
        return [key, vals.join("=")]
      })
    )

    // NextAuth v5 session token cookie names
    const sessionToken =
      cookies["__Secure-authjs.session-token"] ||
      cookies["authjs.session-token"] ||
      cookies["next-auth.session-token"]

    if (!sessionToken) {
      log.warn("No session token found in WebSocket cookies")
      return null
    }

    // Verify the JWT session token
    // We use jose to verify the token, matching NextAuth's approach
    const { jwtVerify } = await import("jose")
    const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
    if (!secret) {
      log.error("AUTH_SECRET not configured")
      return null
    }

    const secretKey = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(sessionToken, secretKey)

    if (!payload.sub) {
      log.warn("Session token missing sub claim")
      return null
    }

    return { userId: payload.sub as string, sub: payload.sub as string }
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
 * The DB-level hasToolAccess takes cognitoSub directly, so we can
 * bypass the session-based wrapper.
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
 */
function sendToClient(ws: WebSocket, message: VoiceServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message))
  }
}

/**
 * Handle a new WebSocket connection for voice sessions.
 *
 * Flow:
 * 1. Authenticate the connection via session cookie
 * 2. Check voice-mode tool access
 * 3. Wait for config message from client
 * 4. Create voice provider and connect to AI service
 * 5. Proxy audio bidirectionally
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
      return
    }

    log.info("Voice connection authenticated", { userId: auth.userId })

    // Step 2: Check voice access
    const hasAccess = await checkVoiceAccess(auth.sub)
    if (!hasAccess) {
      log.warn("User lacks voice-mode access", { userId: auth.userId })
      sendToClient(ws, { type: "error", message: "Voice mode not enabled for this user" })
      ws.close(4003, "Forbidden")
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
      return
    }

    // Step 4: Create and connect provider
    provider = createVoiceProvider(voiceSettings.provider)

    // Step 5: Handle incoming messages from client
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as VoiceClientMessage

        switch (message.type) {
          case "audio": {
            if (provider?.isConnected()) {
              const audioBuffer = Buffer.from(message.data, "base64")
              provider.sendAudio(audioBuffer)
            }
            break
          }

          case "config": {
            // Client can send updated config (e.g. system instruction)
            // This is handled during initial connection setup
            log.debug("Received config update from client", {
              model: message.config.model,
            })
            break
          }

          case "disconnect": {
            log.info("Client requested disconnect")
            provider?.disconnect()
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

    await provider.connect(providerConfig, (event) => {
      switch (event.type) {
        case "audio": {
          sendToClient(ws, {
            type: "audio",
            data: event.data.toString("base64"),
          })
          break
        }

        case "transcript": {
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
        }

        case "state_change": {
          sendToClient(ws, {
            type: "state",
            speaking: event.state.speaking,
          })
          break
        }

        case "error": {
          sendToClient(ws, {
            type: "error",
            message: event.error.message,
          })
          break
        }

        case "session_ended": {
          sendToClient(ws, {
            type: "session_ended",
            reason: event.reason,
          })
          break
        }
      }
    })

    // Signal ready to client
    sendToClient(ws, { type: "ready" })
    log.info("Voice session ready")

    // Step 7: Clean up on close
    ws.on("close", (code, reason) => {
      log.info("Voice WebSocket closed", {
        code,
        reason: reason.toString(),
      })
      provider?.disconnect()
      timer({ status: "success" })
    })

    ws.on("error", (error) => {
      log.error("Voice WebSocket error", {
        error: error.message,
      })
      provider?.disconnect()
      timer({ status: "error" })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error("Voice session setup failed", { error: message })
    sendToClient(ws, { type: "error", message: "Failed to establish voice session" })
    provider?.disconnect()
    ws.close(4500, "Internal error")
    timer({ status: "error" })
  }
}
