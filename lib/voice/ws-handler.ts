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
import { createVoiceProvider } from "./provider-factory"
import { decode } from "@auth/core/jwt"
import { getVoiceAvailability, type VoiceAvailabilityResult } from "./availability"
import {
  MAX_AUDIO_DATA_LENGTH,
  PROVIDER_CONNECT_TIMEOUT_MS,
  MIN_AUDIO_INTERVAL_MS,
  PING_INTERVAL_MS,
  WS_OPEN,
  MAX_CONVERSATION_ID_LENGTH,
  TRANSCRIPT_CONTEXT_TIMEOUT_MS,
} from "./constants"
import { buildInstructionFromConversation } from "./voice-instruction-builder"
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle/utils"
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
 * Non-fatal: returns null if userId cannot be resolved or if the DB lookup
 * exceeds TRANSCRIPT_CONTEXT_TIMEOUT_MS (prevents hanging cleanup on slow DB).
 *
 * Uses the canonical `getUserIdByCognitoSubAsNumber` utility (lib/db/drizzle/utils)
 * which handles string→number conversion and NaN validation internally.
 */
async function resolveTranscriptContext(
  conversationId: string,
  cognitoSub: string,
  voiceModel: string,
  voiceProvider: string,
  logFn: ReturnType<typeof createLogger>,
): Promise<{ conversationId: string; userId: number; voiceModel: string; voiceProvider: string } | null> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    const userId = await Promise.race([
      getUserIdByCognitoSubAsNumber(cognitoSub),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error("Transcript context resolution timed out")),
          TRANSCRIPT_CONTEXT_TIMEOUT_MS,
        )
      }),
    ])
    if (!userId) {
      logFn.warn("Could not resolve userId for transcript persistence")
      return null
    }
    return {
      conversationId,
      userId,
      voiceModel,
      voiceProvider,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logFn.warn("Failed to set up transcript persistence context", { error: msg })
    return null
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
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

/** Mutable session state shared between handleVoiceConnection and its helpers. */
interface VoiceSessionState {
  /** Ref-wrapper so registerMessageHandler can read the provider after it's assigned post-connect */
  providerRef: { current: VoiceProvider | null }
  pingInterval: ReturnType<typeof setInterval> | null
  sessionEnded: boolean
  capturedTranscript: TranscriptEntry[]
  transcriptContext: { conversationId: string; userId: number; voiceModel: string; voiceProvider: string } | null
  /** In-flight promise from resolveTranscriptContext — awaited by cleanup so early disconnects don't lose transcripts */
  transcriptContextPromise: Promise<{ conversationId: string; userId: number; voiceModel: string; voiceProvider: string } | null> | null
}

/** Create a fresh session state object. */
function createSessionState(): VoiceSessionState {
  return {
    providerRef: { current: null },
    pingInterval: null,
    sessionEnded: false,
    capturedTranscript: [],
    transcriptContext: null,
    transcriptContextPromise: null,
  }
}

/**
 * Idempotent session cleanup. Captures transcript, disconnects provider,
 * fires async persistence, and records timing.
 *
 * Awaits transcriptContextPromise if the context resolution is still in-flight,
 * ensuring transcripts are not silently lost on early client disconnects.
 */
async function cleanupSession(
  state: VoiceSessionState,
  status: string,
  logFn: ReturnType<typeof createLogger>,
  timer: ReturnType<typeof startTimer>,
): Promise<void> {
  if (state.sessionEnded) return
  state.sessionEnded = true
  if (state.pingInterval) { clearInterval(state.pingInterval); state.pingInterval = null }

  // Capture transcript BEFORE disconnect clears it from provider memory.
  // Shallow copy the array — disconnect() may mutate/clear the original.
  if (state.providerRef.current) {
    try {
      const providerState = state.providerRef.current.getSessionState()
      if (providerState.transcript.length > 0) {
        state.capturedTranscript = [...providerState.transcript]
      }
    } catch {
      logFn.warn("Failed to capture transcript before disconnect")
    }

    state.providerRef.current.disconnect().catch((e: Error) =>
      logFn.warn("Provider disconnect failed during cleanup", { error: e.message })
    )
    state.providerRef.current = null
  }

  // Early exit: if there's no transcript context (and no in-flight promise) and no captured
  // transcript, there's nothing to save. Avoids unnecessary DB round-trips for sessions that
  // closed during setup (auth failure, config timeout, etc.).
  if (!state.transcriptContext && !state.transcriptContextPromise && state.capturedTranscript.length === 0) {
    timer({ status })
    return
  }

  // If transcriptContext hasn't resolved yet (early disconnect), await the in-flight promise
  // so we don't silently lose the transcript. This is bounded by TRANSCRIPT_CONTEXT_TIMEOUT_MS.
  //
  // Double-await safety: handleVoiceConnection also awaits this same promise. Since JS
  // promises settle exactly once, both awaits resolve to the same value. The sessionEnded
  // flag (set synchronously above) prevents handleVoiceConnection from mutating state
  // after cleanup has run — it checks sessionEnded before starting the ping interval.
  if (!state.transcriptContext && state.transcriptContextPromise) {
    try {
      state.transcriptContext = await state.transcriptContextPromise
    } catch {
      logFn.warn("Transcript context resolution failed during cleanup")
    }
  }

  // Fire-and-forget transcript persistence — non-blocking, non-fatal
  if (state.transcriptContext && state.capturedTranscript.length > 0) {
    const { conversationId, userId, voiceModel, voiceProvider } = state.transcriptContext
    logFn.info("Persisting voice transcript", {
      conversationId,
      entryCount: state.capturedTranscript.length,
    })
    saveVoiceTranscript(conversationId, userId, state.capturedTranscript, voiceModel, voiceProvider)
      .then((result) => {
        logFn.info("Voice transcript persisted", {
          conversationId,
          messageCount: result.messageCount,
          filteredCount: result.filteredCount,
          titleGenerated: result.titleGenerated,
          guardrailsBypassed: result.guardrailsBypassed,
          processingTimeMs: result.processingTimeMs,
        })
      })
      .catch((error: Error) => {
        logFn.error("Failed to persist voice transcript", {
          conversationId,
          error: error.message,
        })
      })
  }

  timer({ status })
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

/**
 * Authenticate and authorize a WebSocket connection for voice.
 * Returns auth info on success, or sends the appropriate error/close and returns null.
 *
 * Uses centralized getVoiceAvailability() which checks:
 * 1. Global voice enabled setting (admin kill switch)
 * 2. User has voice-mode tool access (role-based permission)
 * 3. Voice provider and model are configured
 * 4. Google API key is present
 */
async function authenticateAndAuthorize(
  ws: WebSocket,
  req: IncomingMessage,
  logFn: ReturnType<typeof createLogger>,
  timer: ReturnType<typeof startTimer>,
): Promise<{ userId: string; sub: string; config: NonNullable<VoiceAvailabilityResult["config"]> } | null> {
  const auth = await authenticateWebSocket(req)
  if (!auth) {
    logFn.warn("Unauthorized voice connection attempt")
    sendToClient(ws, { type: "error", message: "Unauthorized" })
    ws.close(4001, "Unauthorized")
    timer({ status: "unauthorized" })
    return null
  }

  logFn.info("Voice connection authenticated", { userId: sanitizeForLogging(auth.userId) })

  let availability: VoiceAvailabilityResult
  try {
    availability = await getVoiceAvailability(auth.sub)
  } catch (err) {
    logFn.error("Availability check failed", { error: err instanceof Error ? err.message : String(err) })
    availability = { available: false, reason: "Availability check failed", type: "error" }
  }
  if (!availability.available) {
    logFn.warn("Voice not available for user", {
      userId: sanitizeForLogging(auth.userId),
      reason: availability.internalReason ?? availability.reason,
    })
    sendToClient(ws, { type: "error", message: availability.reason ?? "Voice mode not available" })
    // Use 4003 for permission issues (admin disabled, user role), 4500 for config issues (missing provider/key),
    // 4500 also for transient errors (availability check failed) since we can't confirm availability
    const closeCode = availability.type === "permission" ? 4003 : 4500
    const closeReason = availability.type === "permission" ? "Forbidden"
      : availability.type === "error" ? "Availability check failed"
      : "Provider not configured"
    ws.close(closeCode, closeReason)
    const timerStatus =
      availability.type === "config" ? "config_error" :
      availability.type === "error" ? "error" :
      "forbidden"
    timer({ status: timerStatus })
    return null
  }

  // config is set by getVoiceAvailability when available === true;
  // guard explicitly rather than relying on non-null assertion
  if (!availability.config) {
    throw new Error("availability.config missing when available=true")
  }
  return { ...auth, config: availability.config }
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

  const session = createSessionState()
  const cleanup = (status: string) => cleanupSession(session, status, log, timer)

  try {
    // Steps 1-2: Authenticate, check voice-mode access, and get validated config
    log.info("New voice WebSocket connection")
    const auth = await authenticateAndAuthorize(ws, req, log, timer)
    if (!auth) return

    // Step 3: Use validated config from availability check (avoids redundant Settings fetch
    // and eliminates TOCTOU window where settings could change between check and use)
    const { config } = auth
    session.providerRef.current = createVoiceProvider(config.provider)

    // Step 4: Register close/error handlers BEFORE provider.connect()
    // cleanup() is async — attach .catch() to prevent unhandled rejections
    // from unexpected throws inside cleanupSession.
    ws.on("close", (code, reason) => {
      log.info("Voice WS closed", { code, reason: reason.toString() })
      cleanup("success").catch((e: Error) =>
        log.error("Unexpected cleanup failure on close", { error: e.message })
      )
    })
    ws.on("error", (error) => {
      log.error("Voice WS error", { error: error.message })
      cleanup("error").catch((e: Error) =>
        log.error("Unexpected cleanup failure on error", { error: e.message })
      )
    })

    // Step 5a: Signal auth OK and wait for client session_config (conversationId only)
    sendToClient(ws, { type: "ready" })
    log.info("Auth complete, waiting for session config")
    const sessionConfig = await waitForSessionConfig(ws, log)

    // Abort if socket closed during wait — prevents leaking a provider connection with no client
    if (session.sessionEnded || ws.readyState !== WS_OPEN) {
      log.info("Socket closed during config wait")
      return
    }

    // Step 5b: Build system instruction server-side and create provider config
    const systemInstruction = await buildSystemInstruction(sessionConfig?.conversationId, auth.sub, log)
    const providerConfig: VoiceProviderConfig = {
      model: config.model,
      language: config.language,
      voiceName: config.voiceName ?? undefined,
      apiKey: config.apiKey,
      systemInstruction,
    }
    log.info("Connecting to voice provider", {
      hasConversationContext: !!sessionConfig?.conversationId,
      hasSystemInstruction: !!systemInstruction,
    })

    const connectAbort = new AbortController()
    const connectTimer = setTimeout(() => connectAbort.abort(), PROVIDER_CONNECT_TIMEOUT_MS)

    try {
      await session.providerRef.current.connect(
        providerConfig,
        (event) => forwardProviderEvent(ws, event),
        connectAbort.signal,
      )
    } finally {
      clearTimeout(connectTimer)
    }

    // Step 7: Register message handler BEFORE signaling ready — prevents
    // dropping early audio frames if the client sends immediately after "ready".
    registerMessageHandler(ws, session.providerRef, log)

    // Signal session is fully ready for audio
    sendToClient(ws, { type: "ready" })
    log.info("Voice session ready")

    // Set up transcript persistence context in the background (non-blocking).
    // The message handler is already registered above, so no audio frames are lost
    // during this async DB lookup.
    //
    // The promise is stored on session state separately from the awaited result
    // because cleanupSession needs it as a fallback: if the client disconnects
    // during THIS await, cleanup fires (setting sessionEnded=true and clearing
    // the ping interval), then awaits transcriptContextPromise to capture the
    // in-flight result. Without storing the promise, early disconnects would
    // silently lose the transcript context.
    if (sessionConfig?.conversationId) {
      session.transcriptContextPromise = resolveTranscriptContext(
        sessionConfig.conversationId, auth.sub, config.model, config.provider, log,
      )
      session.transcriptContext = await session.transcriptContextPromise
      if (session.transcriptContext) {
        log.info("Transcript persistence enabled", {
          conversationId: sessionConfig.conversationId,
        })
      }
    }

    // Step 8: Keepalive ping — cleanup() handles clearInterval on close/error.
    // Guard against the session ending during the transcriptContextPromise await above:
    // if cleanup already ran, starting a new interval would leak because cleanup
    // already cleared pingInterval and won't run again (idempotent guard).
    // NOTE: This guard and the double-await race in cleanupSession are tested
    // indirectly via the ws-handler integration tests (26 tests). The sessionEnded
    // check prevents interval leak — see issue #875 for E2E coverage tracking.
    if (session.sessionEnded) {
      log.info("Session ended during context resolution, skipping ping setup")
      return
    }
    session.pingInterval = setInterval(() => {
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
