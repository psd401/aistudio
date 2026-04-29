/**
 * Gemini Live Voice Provider
 *
 * Server-side implementation using @google/genai SDK's Live API.
 * Handles bidirectional audio streaming with Gemini's real-time models.
 *
 * Key features:
 * - Built-in VAD (voice activity detection) for automatic turn-taking
 * - Input/output audio transcription
 * - Session resumption support
 * - Context window compression
 *
 * Issue #872
 */

import { GoogleGenAI, Modality } from "@google/genai"
import type { Session as GeminiSession, LiveServerMessage, LiveConnectConfig } from "@google/genai"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"
import type {
  VoiceProvider,
  VoiceProviderConfig,
  VoiceProviderEventHandler,
  VoiceSessionState,
  TranscriptEntry,
} from "./types"

const DEFAULT_MODEL = "gemini-2.0-flash-live-001"
/** Max transcript entries to keep in memory — rolling window to bound memory usage */
const MAX_TRANSCRIPT_ENTRIES = 200
/** Max audio buffer size: 64KB PCM ≈ 2 seconds at 16kHz 16-bit mono */
const MAX_AUDIO_BUFFER_SIZE = 64 * 1024
/** Max system instruction length to prevent prompt injection via settings */
const MAX_SYSTEM_INSTRUCTION_LENGTH = 10_000
/** Max voice name length */
const MAX_VOICE_NAME_LENGTH = 100
/**
 * Validate a BCP47-like language code.
 * Uses simple string checks instead of regex to avoid ReDoS concerns
 * flagged by eslint security/detect-unsafe-regex.
 */
function isValidLanguageCode(code: string): boolean {
  if (code.length < 2 || code.length > 35) return false
  // Split on hyphens, validate each subtag is alphanumeric 2-8 chars
  // Numeric subtags are valid in BCP47 (e.g. es-419 for Latin American Spanish)
  const parts = code.split("-")
  if (parts.length === 0 || parts.length > 4) return false
  return parts.every((p) => p.length >= 2 && p.length <= 8 && /^[\dA-Za-z]+$/.test(p))
}

export class GeminiLiveProvider implements VoiceProvider {
  readonly providerId = "gemini-live"

  private session: GeminiSession | null = null
  private onEvent: VoiceProviderEventHandler | null = null
  /** Tracks intentional disconnect to prevent duplicate session_ended events */
  private intentionalDisconnect = false
  private state: VoiceSessionState = {
    connected: false,
    speaking: "none",
    transcript: [],
  }
  private readonly requestId: string
  private readonly log: ReturnType<typeof createLogger>

  constructor() {
    this.requestId = generateRequestId()
    this.log = createLogger({
      requestId: this.requestId,
      context: "GeminiLiveProvider",
    })
  }

  async connect(config: VoiceProviderConfig, onEvent: VoiceProviderEventHandler, signal?: AbortSignal): Promise<void> {
    if (this.session) {
      throw new Error("Session already connected. Disconnect first.")
    }

    if (!config.apiKey) {
      throw new Error("Google API key is required for Gemini Live")
    }

    // Check if already aborted before starting
    if (signal?.aborted) {
      throw new Error("Connection aborted")
    }

    this.onEvent = onEvent
    this.log.info("Connecting to Gemini Live", {
      model: config.model || DEFAULT_MODEL,
      language: config.language,
      hasVoiceName: !!config.voiceName,
      hasSystemInstruction: !!config.systemInstruction,
    })

    const ai = new GoogleGenAI({ apiKey: config.apiKey })
    const liveConfig = this.buildLiveConfig(config)

    try {
      this.session = await ai.live.connect({
        model: config.model || DEFAULT_MODEL,
        config: liveConfig,
        callbacks: {
          onopen: () => {
            this.log.info("Gemini Live session opened")
            this.updateState({ connected: true })
            this.onEvent?.({ type: "state_change", state: this.state })
          },
          onmessage: (message: LiveServerMessage) => {
            this.handleServerMessage(message)
          },
          onerror: (error: ErrorEvent) => {
            this.log.error("Gemini Live session error", {
              error: error.message || "Unknown error",
            })
            this.onEvent?.({
              type: "error",
              error: new Error(error.message || "Gemini Live connection error"),
            })
          },
          onclose: (event: CloseEvent) => {
            this.log.info("Gemini Live session closed", {
              code: event.code,
              reason: event.reason,
            })
            this.updateState({ connected: false, speaking: "none" })
            // Only emit 'finished' if not an intentional disconnect
            // (disconnect() emits 'cancelled' separately)
            if (!this.intentionalDisconnect) {
              this.onEvent?.({ type: "session_ended", reason: "finished" })
            }
            this.session = null
          },
        },
      })

      // If the signal was aborted during connect, disconnect immediately
      // so the Gemini session doesn't leak in the background
      if (signal?.aborted) {
        this.log.info("Connection aborted after session established")
        await this.disconnect()
        throw new Error("Connection aborted")
      }

      // Listen for future abort (e.g., timeout fires after connect resolves but
      // before the caller processes the result)
      signal?.addEventListener("abort", () => {
        this.log.info("Connection aborted via signal")
        this.disconnect().catch(() => { /* best-effort */ })
      }, { once: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Log full error internally but throw a generic message to prevent
      // leaking SDK internals (API keys, URLs) to the client
      this.log.error("Failed to connect to Gemini Live", { error: sanitizeForLogging(message) })
      throw new Error("Failed to connect to Gemini Live API")
    }
  }

  async disconnect(): Promise<void> {
    if (!this.session) {
      return
    }

    this.log.info("Disconnecting from Gemini Live")
    this.intentionalDisconnect = true
    try {
      this.session.close()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log.warn("Error during disconnect", { error: message })
    } finally {
      this.session = null
      // Defense-in-depth: explicitly clear transcript data (student speech)
      // so it doesn't linger in memory if the provider instance is retained
      this.state.transcript = []
      this.updateState({ connected: false, speaking: "none" })
      this.onEvent?.({ type: "session_ended", reason: "cancelled" })
      this.onEvent = null
    }
  }

  /**
   * Send audio data to the AI service.
   * Expects PCM16 16kHz mono audio. Max 64KB per call.
   */
  sendAudio(audioData: Buffer): void {
    if (!this.session) {
      this.log.warn("Cannot send audio: session not connected")
      return
    }

    if (audioData.length > MAX_AUDIO_BUFFER_SIZE) {
      this.log.warn("Audio buffer too large, dropping frame", {
        size: audioData.length,
        max: MAX_AUDIO_BUFFER_SIZE,
      })
      return
    }

    // Convert Buffer to the SDK's Blob format (base64-encoded data with MIME type)
    const sdkBlob = {
      data: audioData.toString("base64"),
      mimeType: "audio/pcm;rate=16000",
    }

    try {
      this.session.sendRealtimeInput({ audio: sdkBlob })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log.error("Failed to send audio", { error: message })
      this.onEvent?.({
        type: "error",
        error: new Error(`Failed to send audio: ${message}`),
      })
    }
  }

  getSessionState(): VoiceSessionState {
    return { ...this.state, transcript: [...this.state.transcript] }
  }

  isConnected(): boolean {
    return this.state.connected && this.session !== null
  }

  /**
   * Build the LiveConnectConfig from our VoiceProviderConfig.
   * Validates and sanitizes all external inputs before forwarding to the API.
   */
  private buildLiveConfig(config: VoiceProviderConfig): LiveConnectConfig {
    const liveConfig: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    }

    // Voice selection — validate name length to prevent injection via settings
    if (config.voiceName) {
      const sanitizedVoiceName = config.voiceName.slice(0, MAX_VOICE_NAME_LENGTH)
      liveConfig.speechConfig = {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: sanitizedVoiceName,
          },
        },
      }
    }

    // Language — validate BCP47 format
    const language = config.language
    if (language && isValidLanguageCode(language)) {
      if (liveConfig.speechConfig) {
        liveConfig.speechConfig.languageCode = language
      } else {
        liveConfig.speechConfig = { languageCode: language }
      }
    } else if (language) {
      this.log.warn("Invalid language code, skipping", { language })
    }

    // System instruction — truncate to prevent prompt injection via settings
    if (config.systemInstruction) {
      liveConfig.systemInstruction = config.systemInstruction.slice(0, MAX_SYSTEM_INSTRUCTION_LENGTH)
    }

    // Enable context window compression for long conversations
    liveConfig.contextWindowCompression = {
      slidingWindow: {
        targetTokens: "10000", // SDK type is string, not number — intentional
      },
    }

    // Enable session resumption — server-side only for this issue.
    // The Gemini SDK handles resumption internally via session tokens.
    // Client-facing resumption (passing previousSessionId through
    // VoiceProviderConfig) is deferred to a later issue in the voice epic
    // when the client UI supports reconnection flows.
    liveConfig.sessionResumption = {}

    return liveConfig
  }

  /**
   * Handle messages from the Gemini Live server.
   */
  private handleServerMessage(message: LiveServerMessage): void {
    const content = message.serverContent

    if (!content) {
      if (message.setupComplete) {
        this.log.debug("Gemini Live setup complete")
      }
      return
    }

    this.handleAudioContent(content)
    this.handleTranscriptions(content)
    this.handleTurnState(content)
  }

  /**
   * Process audio data from model turns.
   */
  private handleAudioContent(content: NonNullable<LiveServerMessage["serverContent"]>): void {
    if (!content.modelTurn?.parts) return

    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data) {
        if (this.state.speaking !== "assistant") {
          this.updateState({ speaking: "assistant" })
          this.onEvent?.({ type: "state_change", state: this.state })
        }

        const audioBuffer = Buffer.from(part.inlineData.data, "base64")
        this.onEvent?.({ type: "audio", data: audioBuffer })
      }
    }
  }

  /**
   * Process input and output transcriptions.
   */
  private handleTranscriptions(content: NonNullable<LiveServerMessage["serverContent"]>): void {
    if (content.inputTranscription?.text) {
      const entry: TranscriptEntry = {
        role: "user",
        text: content.inputTranscription.text,
        timestamp: new Date(),
        isFinal: true,
      }
      this.addTranscript(entry)
      this.onEvent?.({ type: "transcript", entry })
    }

    if (content.outputTranscription?.text) {
      const entry: TranscriptEntry = {
        role: "assistant",
        text: content.outputTranscription.text,
        timestamp: new Date(),
        isFinal: true,
      }
      this.addTranscript(entry)
      this.onEvent?.({ type: "transcript", entry })
    }
  }

  /**
   * Handle turn completion and interruption signals.
   */
  private handleTurnState(content: NonNullable<LiveServerMessage["serverContent"]>): void {
    if (content.turnComplete) {
      this.updateState({ speaking: "none" })
      this.onEvent?.({ type: "state_change", state: this.state })
    }

    if (content.interrupted) {
      this.updateState({ speaking: "user" })
      this.onEvent?.({ type: "state_change", state: this.state })
    }
  }

  /**
   * Update internal state (partial update).
   */
  private updateState(partial: Partial<VoiceSessionState>): void {
    this.state = { ...this.state, ...partial }
  }

  /**
   * Add a transcript entry with rolling window to bound memory.
   */
  private addTranscript(entry: TranscriptEntry): void {
    this.state.transcript.push(entry)
    if (this.state.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
      this.state.transcript = this.state.transcript.slice(-MAX_TRANSCRIPT_ENTRIES)
    }
  }
}
