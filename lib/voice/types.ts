/**
 * Voice Provider Abstraction Layer
 *
 * Defines the interfaces for real-time voice conversation providers.
 * Designed to support multiple backends (Gemini Live, OpenAI Realtime, ElevenLabs, etc.)
 *
 * Architecture:
 *   Client ↔ WebSocket ↔ Next.js Server ↔ Provider SDK ↔ AI Service
 *
 * WebSocket Protocol (ws://.../api/nexus/voice):
 *   1. Client connects with session cookie for authentication
 *   2. Server validates JWT, checks hasToolAccess("voice-mode")
 *   3. Server sends { type: "ready" } when Gemini Live session is established
 *   4. Client sends { type: "audio", data: "<base64 PCM16 16kHz mono>" }
 *   5. Server forwards audio to Gemini, relays responses back:
 *      - { type: "audio", data: "<base64>" } — model speech audio
 *      - { type: "transcript", entry: { role, text, isFinal, timestamp } }
 *      - { type: "state", speaking: "user"|"assistant"|"none" }
 *      - { type: "error", message: string }
 *      - { type: "session_ended", reason: string }
 *   6. Client sends { type: "disconnect" } to end session
 *
 * Close codes: 4001=Unauthorized, 4003=Forbidden, 4500=Server Error
 *
 * Issue #872
 */

/**
 * Configuration for establishing a voice session with a provider.
 */
export interface VoiceProviderConfig {
  /** The model identifier (e.g. 'gemini-3.1-flash-live-preview') */
  model: string
  /** BCP-47 language code (e.g. 'en-US') */
  language?: string
  /** Provider-specific voice name/ID */
  voiceName?: string
  /** System instruction for the voice conversation (populated from conversation context, not admin settings) */
  systemInstruction?: string
  /** Optional API key override (normally read from Settings) */
  apiKey?: string
}

/**
 * A single transcript entry from a voice conversation.
 */
export interface TranscriptEntry {
  role: "user" | "assistant"
  text: string
  timestamp: Date
  /** Whether this transcript is finalized or still being streamed */
  isFinal: boolean
}

/**
 * State of an active voice session.
 */
export interface VoiceSessionState {
  connected: boolean
  speaking: "user" | "assistant" | "none"
  transcript: TranscriptEntry[]
}

/**
 * Events emitted by a voice provider during a session.
 * Used to communicate between the provider and the WebSocket proxy.
 */
export type VoiceProviderEvent =
  | { type: "audio"; data: Buffer }
  | { type: "transcript"; entry: TranscriptEntry }
  | { type: "state_change"; state: VoiceSessionState }
  | { type: "error"; error: Error }
  | { type: "session_ended"; reason: "finished" | "cancelled" | "error" }

/**
 * Callback for receiving events from the provider.
 */
export type VoiceProviderEventHandler = (event: VoiceProviderEvent) => void

/**
 * Server-side voice provider interface.
 *
 * Implementations handle the connection to the AI service's real-time API.
 * The WebSocket proxy route instantiates and manages these providers.
 *
 * Each provider instance represents a single voice session.
 */
export interface VoiceProvider {
  /** Provider identifier (e.g. 'gemini-live', 'openai-realtime') */
  readonly providerId: string

  /**
   * Establish a connection to the AI service.
   * @param config - Voice session configuration
   * @param onEvent - Callback for provider events (audio, transcripts, state changes)
   */
  connect(config: VoiceProviderConfig, onEvent: VoiceProviderEventHandler): Promise<void>

  /**
   * Disconnect and clean up the session.
   */
  disconnect(): Promise<void>

  /**
   * Send audio data from the client to the AI service.
   * @param audioData - Raw audio bytes (PCM16, 16kHz mono by default)
   */
  sendAudio(audioData: Buffer): void

  /**
   * Get the current session state.
   */
  getSessionState(): VoiceSessionState

  /**
   * Whether the provider is currently connected.
   */
  isConnected(): boolean
}

/**
 * Messages sent over the client ↔ server WebSocket connection.
 * These are the protocol messages for the voice proxy.
 */
export type VoiceClientMessage =
  | { type: "audio"; data: string } // base64-encoded audio
  | { type: "disconnect" }

export type VoiceServerMessage =
  | { type: "audio"; data: string } // base64-encoded audio
  | { type: "transcript"; entry: Omit<TranscriptEntry, "timestamp"> & { timestamp: string } }
  | { type: "state"; speaking: VoiceSessionState["speaking"] }
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "session_ended"; reason: string }
