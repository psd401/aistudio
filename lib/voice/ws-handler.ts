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
  MAX_CONVERSATION_ID_LENGTH,
} from "./constants"
import { buildInstructionFromConversation } from "./voice-instruction-builder"
import { getUserIdByCognitoSub } from "@/lib/db/drizzle/users"
import { saveVoiceTranscript } from "./transcript-service"
import type {
  VoiceProvider,
  VoiceProviderConfig,
  VoiceClientMessage,
  VoiceServerMessage,
  VoiceProviderEvent,
  TranscriptEntry,
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

const VALID_CLIENT_MESSAGE_TYPES = new Set(["audio", "session_config", "disconnect"])

/** Validate that a parsed message has the expected shape and a known type. */
function isValidClientMessage(msg: unknown): msg is VoiceClientMessage {
  if (typeof msg !== "object" || msg === null) return false
  const obj = msg as Record<string, unknown>
  if (typeof obj.type !== "string" || !VALID_CLIENT_MESSAGE_TYPES.has(obj.type)) return false
  if (obj.type === "audio" && typeof obj.data !== "string") return false
  if (obj.type === "session_config") {
    if (obj.conversationId !== undefined && typeof obj.conversationId !== "string") return false
  }
  return true
}

/**
 * Resolve the numeric userId from a Cognito sub and build the transcript context.
 * Non-fatal: returns null if userId cannot be resolved.
 */
async function resolveTranscriptContext(
  conversationId: string,
  cognitoSub: string,
  voiceModel: string,
  logFn: ReturnType<typeof createLogger>,
): Promise<{ conversationId: string; userId: number; voiceModel: string } | null> {
  try {
    const userIdStr = await getUserIdByCognitoSub(cognitoSub)
    if (!userIdStr) {
      logFn.warn("Could not resolve userId for transcript persistence")
      return null
    }
    return {
      conversationId,
      userId: Number.parseInt(userIdStr, 10),
      voiceModel,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logFn.warn("Failed to set up transcript persistence context", { error: msg })
    return null
  }
}

/** Register the client message handler on the WebSocket. */
function registerMessageHandler(
  ws: WebSocket,
  providerRef: { current: VoiceProvider | null },
  logFn: ReturnType<typeof createLogger>,
): void {
  let lastAudioTime = 0
  ws.on("message", (data) => {
    try {
      const parsed: unknown = JSON.parse(data.toString())
      if (!isValidClientMessage(parsed)) {
        logFn.warn("Invalid client message format")
        return
      }

      switch (parsed.type) {
        case "audio": {
          if (!providerRef.current?.isConnected()) break
          if (parsed.data.length > MAX_AUDIO_DATA_LENGTH) {
            logFn.warn("Audio data too large", { length: parsed.data.length })
            break
          }
          const now = Date.now()
          if (now - lastAudioTime < MIN_AUDIO_INTERVAL_MS) break
          lastAudioTime = now
          providerRef.current.sendAudio(Buffer.from(parsed.data, "base64"))
          break
        }

        case "session_config":
          logFn.debug("Ignoring late session_config (provider already connected)")
          break

        case "disconnect": {
          logFn.info("Client requested disconnect")
          providerRef.current?.disconnect().catch((e: Error) =>
            logFn.warn("Error during client-requested disconnect", { error: e.message })
          )
          break
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logFn.error("Error processing client message", { error: errorMessage })
    }
  })
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
): Promise<{ conversationId?: string } | null> {
  return new Promise((resolve) => {
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

          const rawConversationId = typeof parsed.conversationId === "string"
            ? parsed.conversationId.slice(0, MAX_CONVERSATION_ID_LENGTH)
            : undefined
          const conversationId = rawConversationId && isUuidFormat(rawConversationId)
            ? rawConversationId
            : undefined
          if (rawConversationId && !conversationId) {
            logFn.warn("Invalid conversationId format in session_config, discarding")
          }

          logFn.info("Session config received", { hasConversationId: !!conversationId })
          resolve({ conversationId })
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

/** Returns a reason string if voice config is invalid, or null if OK. */
function validateVoiceConfig(
  settings: { provider: string | null; model: string | null },
  googleApiKey: string | null,
): string | null {
  if (!googleApiKey) return "missing_api_key"
  if (!settings.provider || !settings.model || !isSupportedVoiceProvider(settings.provider)) return "invalid_provider"
  return null
}

/**
 * Build system instruction from conversation messages (server-side).
 * Non-fatal: returns undefined if conversation doesn't exist, isn't owned, or DB fails.
 */
async function buildSystemInstruction(
  conversationId: string | undefined,
  cognitoSub: string,
  logFn: ReturnType<typeof createLogger>,
): Promise<string | undefined> {
  if (!conversationId) return undefined
  try {
    return await buildInstructionFromConversation(conversationId, cognitoSub)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logFn.warn("Failed to build voice instruction from conversation", { error: msg })
    return undefined
  }
}

/**
 * Handle a new WebSocket connection for voice sessions.
 *
 * Flow:
 * 1. Authenticate via Auth.js session cookie
 * 2. Check voice-mode tool access
 * 3. Get voice settings and create provider
 * 4. Register close/error handlers (BEFORE connect)
 * 5a. Signal auth OK and wait for session_config from client
 * 5b. Build system instruction server-side from conversation messages
 * 6. Connect to AI service with timeout
 * 7. Register message handler (AFTER connect — clients must wait for "ready")
 * 8. Start keepalive ping
 */
export async function handleVoiceConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, context: "voice-ws" })
  const timer = startTimer("voice-session")

  /** Mutable ref so both cleanup() and registerMessageHandler() share the same provider pointer */
  const providerRef: { current: VoiceProvider | null } = { current: null }
  let pingInterval: ReturnType<typeof setInterval> | null = null
  let sessionEnded = false
  /** Captured transcript for persistence — snapshot taken before provider.disconnect() clears it */
  let capturedTranscript: TranscriptEntry[] = []
  /** Session context for transcript persistence — set after auth + config */
  let transcriptContext: { conversationId: string; userId: number; voiceModel: string } | null = null

  /** Idempotent cleanup — synchronous to avoid swallowed errors in event handlers */
  function cleanup(status: string) {
    if (sessionEnded) return
    sessionEnded = true
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null }

    // Capture transcript BEFORE disconnect clears it from provider memory
    if (providerRef.current) {
      try {
        const state = providerRef.current.getSessionState()
        if (state.transcript.length > 0) {
          capturedTranscript = state.transcript
        }
      } catch {
        log.warn("Failed to capture transcript before disconnect")
      }

      providerRef.current.disconnect().catch((e: Error) =>
        log.warn("Provider disconnect failed during cleanup", { error: e.message })
      )
      providerRef.current = null
    }

    // Fire-and-forget transcript persistence — non-blocking, non-fatal
    if (transcriptContext && capturedTranscript.length > 0) {
      const { conversationId, userId, voiceModel } = transcriptContext
      log.info("Persisting voice transcript", {
        conversationId,
        entryCount: capturedTranscript.length,
      })
      saveVoiceTranscript(conversationId, userId, capturedTranscript, voiceModel)
        .then((result) => {
          log.info("Voice transcript persisted", {
            conversationId,
            messageCount: result.messageCount,
            filteredCount: result.filteredCount,
            titleGenerated: result.titleGenerated,
            processingTimeMs: result.processingTimeMs,
          })
        })
        .catch((error: Error) => {
          log.error("Failed to persist voice transcript", {
            conversationId,
            error: error.message,
          })
        })
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

    const configError = validateVoiceConfig(voiceSettings, googleApiKey)
    if (configError) {
      log.error("Voice not configured", { reason: configError,
        action: "Set VOICE_PROVIDER, VOICE_MODEL, and GOOGLE_API_KEY in Admin > System Settings" })
      sendToClient(ws, { type: "error", message: "Voice provider not configured" })
      ws.close(4500, "Provider not configured")
      timer({ status: "error", reason: configError })
      return
    }
    // Non-null safe: validateVoiceConfig returned null, so provider is valid
    providerRef.current = createVoiceProvider(voiceSettings.provider!)

    // Step 4: Register close/error handlers BEFORE provider.connect()
    ws.on("close", (code, reason) => { log.info("Voice WS closed", { code, reason: reason.toString() }); cleanup("success") })
    ws.on("error", (error) => { log.error("Voice WS error", { error: error.message }); cleanup("error") })

    // Step 5a: Signal auth OK and wait for client session_config (conversationId only)
    sendToClient(ws, { type: "ready" })
    log.info("Auth complete, waiting for session config")
    const sessionConfig = await waitForSessionConfig(ws, log)

    // Abort if socket closed during wait — prevents leaking a provider connection with no client
    if (sessionEnded || ws.readyState !== WS_OPEN) {
      log.info("Socket closed during config wait")
      return
    }

    // Step 5b: Build system instruction server-side and create provider config
    const systemInstruction = await buildSystemInstruction(sessionConfig?.conversationId, auth.sub, log)
    const providerConfig: VoiceProviderConfig = {
      model: voiceSettings.model!,
      language: voiceSettings.language,
      voiceName: voiceSettings.voiceName ?? undefined,
      apiKey: googleApiKey!,
      systemInstruction,
    }
    log.info("Connecting to voice provider", {
      hasConversationContext: !!sessionConfig?.conversationId,
      hasSystemInstruction: !!systemInstruction,
    })

    const connectAbort = new AbortController()
    const connectTimer = setTimeout(() => connectAbort.abort(), PROVIDER_CONNECT_TIMEOUT_MS)

    try {
      await providerRef.current.connect(
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

    // Set up transcript persistence context (requires conversationId + resolved userId)
    if (sessionConfig?.conversationId) {
      transcriptContext = await resolveTranscriptContext(
        sessionConfig.conversationId, auth.sub, voiceSettings.model!, log,
      )
      if (transcriptContext) {
        log.info("Transcript persistence enabled", {
          conversationId: sessionConfig.conversationId,
        })
      }
    }

    // Step 7: Register message handler AFTER connect (clients must wait for second "ready")
    registerMessageHandler(ws, providerRef, log)

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
