/**
 * Shared constants for the voice module.
 *
 * Used by both ws-handler.ts (ESM, Next.js runtime) and voice-server.js (CJS, standalone).
 * voice-server.js cannot import this directly (CJS/ESM boundary), so values are duplicated
 * there with a cross-reference comment. Keep both in sync.
 *
 * Issue #872
 */

/** WebSocket endpoint path for voice sessions */
export const VOICE_WS_PATH = "/api/nexus/voice"

/** Max WebSocket frame payload: 64KB. PCM 16kHz 16-bit mono = 32KB/sec. */
export const WS_MAX_PAYLOAD = 64 * 1024

/** Max base64 audio string length per message: ~85KB base64 ≈ 64KB decoded.
 *  Aligned with WS_MAX_PAYLOAD so the frame limit and message limit match. */
export const MAX_AUDIO_DATA_LENGTH = 85_334 // Math.ceil(WS_MAX_PAYLOAD * 4/3)

/** Connection timeout for provider.connect() (ms) */
export const PROVIDER_CONNECT_TIMEOUT_MS = Number.parseInt(
  process.env.VOICE_CONNECT_TIMEOUT_MS || "30000", 10
)

/** Min interval between audio messages per connection (ms) — rate limit */
export const MIN_AUDIO_INTERVAL_MS = 20

/** ALB keepalive ping interval — must be less than ALB idleTimeout (300s) */
export const PING_INTERVAL_MS = 240_000

/** WebSocket readyState OPEN constant (ws library value) */
export const WS_OPEN = 1

/**
 * Voice context budget constants — these two govern how much conversation
 * history the voice model receives as system instruction.
 *
 * MAX_VOICE_CONTEXT_MESSAGES: How many recent messages to fetch from the DB.
 * MAX_SESSION_INSTRUCTION_LENGTH: Character cap on the formatted instruction.
 *
 * Used by voice-instruction-builder.ts (server-side instruction building).
 */
export const MAX_VOICE_CONTEXT_MESSAGES = 20
export const MAX_SESSION_INSTRUCTION_LENGTH = 10_000

/** Max length for conversationId in session_config (UUID = 36 chars) */
export const MAX_CONVERSATION_ID_LENGTH = 36
