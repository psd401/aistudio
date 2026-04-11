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
import {
  MAX_AUDIO_DATA_LENGTH,
  PROVIDER_CONNECT_TIMEOUT_MS,
  MIN_AUDIO_INTERVAL_MS,
  PING_INTERVAL_MS,
  WS_OPEN,
} from "./constants"
import type {
  VoiceProvider,
  VoiceProviderConfig,
  VoiceClientMessage,
  VoiceServerMessage,
  VoiceProviderEvent,
} from "./types"

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
/** Parse raw cookie header into a key-value map. Uses Object.create(null) since cookie names are user-controlled. */
function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null)
  for (const c of cookieHeader.split(";")) {
    const [key, ...vals] = c.trim().split("=")
    cookies[key.trim()] = vals.join("=").trim()
  }
  return cookies
}

/** Find Auth.js session token from cookies, handling chunked cookies. */
function findSessionToken(cookies: Record<string, string>): { token: string; salt: string } | null {
  const cookieNames = ["__Secure-authjs.session-token", "authjs.session-token", "next-auth.session-token"]
  for (const name of cookieNames) {
    if (cookies[name]) return { token: cookies[name], salt: name }
    // Chunked cookies: name.0, name.1, ... (Auth.js splits large tokens, typically 2-3 chunks)
    const chunks: string[] = []
    for (let i = 0; i < 20; i++) {
      const chunk = cookies[`${name}.${i}`]
      if (!chunk) break
      chunks.push(chunk)
    }
    if (chunks.length > 0) return { token: chunks.join(""), salt: name }
  }
  return null
}

async function authenticateWebSocket(req: IncomingMessage): Promise<{ userId: string; sub: string } | null> {
  const log = createLogger({ context: "voice-ws-auth" })

  try {
    const cookies = parseCookies(req.headers.cookie || "")
    const session = findSessionToken(cookies)

    if (!session) {
      log.warn("No session token found in WebSocket cookies")
      return null
    }

    const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
    if (!secret) {
      log.error("AUTH_SECRET not configured")
      return null
    }

    const payload = await decode({ token: session.token, salt: session.salt, secret })

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

/** Send a typed message to the client WebSocket. */
function sendToClient(ws: WebSocket, message: VoiceServerMessage): void {
  if (ws.readyState === WS_OPEN) {
    ws.send(JSON.stringify(message))
  }
}

/** Max length for systemInstruction passed via session_config (10K chars) */
const MAX_SESSION_INSTRUCTION_LENGTH = 10_000

/** Max length for conversationId in session_config (UUID = 36 chars) */
const MAX_CONVERSATION_ID_LENGTH = 36

/** Simple UUID format check — validates 8-4-4-4-12 hex pattern using a non-backtracking character class regex */
function isUuidFormat(value: string): boolean {
  if (value.length !== 36) return false
  const hyphenPositions = [8, 13, 18, 23]
  for (const pos of hyphenPositions) {
    if (value[pos] !== "-") return false
  }
  // Check all non-hyphen chars are hex digits
  const hexOnly = value.replace(/-/g, "")
  return hexOnly.length === 32 && /^[\da-f]+$/i.test(hexOnly)
}

/** Validate that a parsed message has the expected shape. */
function isValidClientMessage(msg: unknown): msg is VoiceClientMessage {
  if (typeof msg !== "object" || msg === null) return false
  const obj = msg as Record<string, unknown>
  if (typeof obj.type !== "string") return false
  if (obj.type === "audio" && typeof obj.data !== "string") return false
  if (obj.type === "session_config") {
    // conversationId is optional string (UUID)
    if (obj.conversationId !== undefined && typeof obj.conversationId !== "string") return false
    // systemInstruction is optional string
    if (obj.systemInstruction !== undefined && typeof obj.systemInstruction !== "string") return false
    return true
  }
  return true
}

/** Forward a provider event to the client WebSocket. */
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
      // Send generic message to client — provider errors may contain URLs, API keys, or request IDs
      sendToClient(ws, { type: "error", message: "Voice provider error" })
      break
    case "session_ended":
      sendToClient(ws, { type: "session_ended", reason: event.reason })
      break
  }
}

/**
 * Timeout for waiting for session_config message from client (ms).
 *
 * 5s is a deliberate trade-off: after the server sends the first "ready" (auth OK),
 * the client must respond with session_config within this window. Under mobile or
 * degraded networks (200-400ms RTT) this is generous. The consequence of timeout
 * is graceful — the session proceeds with default settings (no conversation context),
 * not a failure. Do NOT tighten this value without testing on high-latency links;
 * the round-trip includes: WS frame delivery, client-side JS execution of
 * socket.send(), and return delivery.
 */
const SESSION_CONFIG_TIMEOUT_MS = 5_000

/**
 * Wait for the client to send a session_config message.
 * The client MUST send session_config as its first message after WebSocket open.
 * Returns the config or null if the client sends nothing within the timeout
 * (in which case the session proceeds with default settings).
 */
function waitForSessionConfig(
  ws: WebSocket,
  logFn: ReturnType<typeof createLogger>,
): Promise<{ conversationId?: string; systemInstruction?: string } | null> {
  return new Promise((resolve) => {
    /** Remove all listeners registered by this function */
    function cleanupListeners() {
      clearTimeout(timeout)
      ws.removeListener("message", onMessage)
      ws.removeListener("close", onClose)
      ws.removeListener("error", onError)
    }

    const timeout = setTimeout(() => {
      cleanupListeners()
      logFn.debug("No session_config received within timeout, proceeding with defaults")
      resolve(null)
    }, SESSION_CONFIG_TIMEOUT_MS)

    function onClose() {
      cleanupListeners()
      logFn.debug("WebSocket closed while waiting for session_config")
      resolve(null)
    }

    function onError() {
      cleanupListeners()
      logFn.debug("WebSocket error while waiting for session_config")
      resolve(null)
    }

    function onMessage(data: WebSocket.RawData) {
      try {
        const parsed: unknown = JSON.parse(data.toString())
        if (!isValidClientMessage(parsed)) return
        if (parsed.type === "session_config") {
          cleanupListeners()

          // Sanitize and validate inputs
          const rawConversationId = typeof parsed.conversationId === "string"
            ? parsed.conversationId.slice(0, MAX_CONVERSATION_ID_LENGTH)
            : undefined
          const conversationId = rawConversationId && isUuidFormat(rawConversationId)
            ? rawConversationId
            : undefined
          if (rawConversationId && !conversationId) {
            logFn.warn("Invalid conversationId format in session_config, discarding")
          }
          // THREAT MODEL: systemInstruction is client-supplied and passed verbatim to
          // the Gemini Live session. A user whose conversation history contains adversarially
          // crafted text (e.g., "Ignore all previous instructions…") will have that text
          // injected into the voice model's system prompt. This is an inherent architectural
          // risk when embedding user-controlled content in system instructions. Mitigations:
          // (1) length cap prevents unlimited injection, (2) Bedrock guardrails apply to
          // the model output, (3) the same content is already visible to the text model.
          // Full mitigation would require server-side instruction building from conversationId
          // (fetching messages from DB and verifying ownership), which is deferred as a
          // follow-on to this PR.
          const systemInstruction = typeof parsed.systemInstruction === "string"
            ? parsed.systemInstruction.slice(0, MAX_SESSION_INSTRUCTION_LENGTH)
            : undefined

          logFn.info("Session config received", {
            hasConversationId: !!conversationId,
            hasSystemInstruction: !!systemInstruction,
            instructionLength: systemInstruction?.length,
          })

          resolve({ conversationId, systemInstruction })
        }
      } catch {
        logFn.debug("Non-JSON message received while waiting for session_config")
      }
    }

    ws.on("message", onMessage)
    ws.on("close", onClose)
    ws.on("error", onError)
  })
}

/**
 * Handle a new WebSocket connection for voice sessions.
 *
 * Flow:
 * 1. Authenticate via Auth.js session cookie
 * 2. Check voice-mode tool access
 * 3. Get voice settings and create provider
 * 4. Register close/error handlers (BEFORE connect)
 * 5. Signal auth OK and wait for session_config from client
 * 6. Connect to AI service with timeout (including systemInstruction from config)
 * 7. Register message handler (AFTER connect — clients must wait for "ready")
 * 8. Start keepalive ping
 */
export async function handleVoiceConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, context: "voice-ws" })
  const timer = startTimer("voice-session")

  let provider: VoiceProvider | null = null
  let pingInterval: ReturnType<typeof setInterval> | null = null
  let sessionEnded = false

  /** Idempotent cleanup — synchronous to avoid swallowed errors in event handlers */
  function cleanup(status: string) {
    if (sessionEnded) return
    sessionEnded = true
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
    if (provider) {
      provider.disconnect().catch((e: Error) =>
        log.warn("Provider disconnect failed during cleanup", { error: e.message })
      )
      provider = null
    }
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

    // Step 3: Get voice settings and API key (cached 5-min TTL; changes take effect on new sessions)
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

    if (!voiceSettings.provider || !voiceSettings.model || !isSupportedVoiceProvider(voiceSettings.provider)) {
      log.error("Voice settings not configured", { provider: voiceSettings.provider, model: voiceSettings.model })
      sendToClient(ws, { type: "error", message: "Voice provider not configured" })
      ws.close(4500, "Provider not configured")
      timer({ status: "error", reason: "invalid_provider" })
      return
    }
    provider = createVoiceProvider(voiceSettings.provider)

    // Step 4: Register close/error handlers BEFORE provider.connect()
    ws.on("close", (code, reason) => {
      log.info("Voice WebSocket closed", { code, reason: reason.toString() })
      cleanup("success")
    })

    ws.on("error", (error) => {
      log.error("Voice WebSocket error", { error: error.message })
      cleanup("error")
    })

    // Step 5: Signal auth OK and wait for client session_config (conversationId + systemInstruction)
    sendToClient(ws, { type: "ready" })
    log.info("Auth complete, waiting for session config")
    const sessionConfig = await waitForSessionConfig(ws, log)

    // Abort if socket closed during wait — prevents leaking a provider connection with no client
    if (sessionEnded || ws.readyState !== WS_OPEN) { log.info("Socket closed during config wait"); return }

    // Step 6: Connect to AI service with timeout + abort signal
    const providerConfig: VoiceProviderConfig = {
      model: voiceSettings.model,
      language: voiceSettings.language,
      voiceName: voiceSettings.voiceName ?? undefined,
      apiKey: googleApiKey,
      systemInstruction: sessionConfig?.systemInstruction,
    }

    log.info("Connecting to voice provider", {
      hasConversationContext: !!sessionConfig?.conversationId,
      hasSystemInstruction: !!providerConfig.systemInstruction,
    })

    const connectAbort = new AbortController()
    const connectTimer = setTimeout(() => connectAbort.abort(), PROVIDER_CONNECT_TIMEOUT_MS)

    try {
      await provider.connect(
        providerConfig,
        (event) => forwardProviderEvent(ws, event),
        connectAbort.signal,
      )
    } finally {
      clearTimeout(connectTimer)
    }

    // Signal session is fully ready for audio
    sendToClient(ws, { type: "ready" })
    log.info("Voice session ready")

    // Step 7: Register message handler AFTER connect (clients must wait for second "ready")
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
            // Validate base64 string length (aligned with WS_MAX_PAYLOAD via 4:3 ratio)
            if (parsed.data.length > MAX_AUDIO_DATA_LENGTH) {
              log.warn("Audio data too large", { length: parsed.data.length })
              break
            }
            const now = Date.now()
            if (now - lastAudioTime < MIN_AUDIO_INTERVAL_MS) break
            lastAudioTime = now
            provider.sendAudio(Buffer.from(parsed.data, "base64"))
            break
          }

          case "session_config": {
            // session_config after provider connect is a no-op — system instruction
            // is immutable once the Gemini session starts. Log and ignore.
            log.debug("Ignoring late session_config (provider already connected)")
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

    // Step 8: Keepalive ping — cleanup() handles clearInterval on close/error
    pingInterval = setInterval(() => {
      if (ws.readyState === WS_OPEN) ws.ping()
    }, PING_INTERVAL_MS)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error("Voice session setup failed", { error: message })
    sendToClient(ws, { type: "error", message: "Failed to establish voice session" })
    cleanup("error") // idempotent — sets sessionEnded, clears interval, disconnects provider
    ws.removeAllListeners("message")
    ws.removeAllListeners("close")
    ws.removeAllListeners("error")
    ws.close(4500, "Internal error")
  }
}
