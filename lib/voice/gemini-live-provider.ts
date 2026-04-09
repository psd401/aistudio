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
import { createLogger, generateRequestId } from "@/lib/logger"
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

export class GeminiLiveProvider implements VoiceProvider {
  readonly providerId = "gemini-live"

  private session: GeminiSession | null = null
  private onEvent: VoiceProviderEventHandler | null = null
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

  async connect(config: VoiceProviderConfig, onEvent: VoiceProviderEventHandler): Promise<void> {
    if (this.session) {
      throw new Error("Session already connected. Disconnect first.")
    }

    if (!config.apiKey) {
      throw new Error("Google API key is required for Gemini Live")
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
            this.onEvent?.({ type: "session_ended", reason: "finished" })
            this.session = null
          },
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log.error("Failed to connect to Gemini Live", { error: message })
      throw new Error(`Failed to connect to Gemini Live: ${message}`)
    }
  }

  async disconnect(): Promise<void> {
    if (!this.session) {
      return
    }

    this.log.info("Disconnecting from Gemini Live")
    try {
      this.session.conn.close()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log.warn("Error during disconnect", { error: message })
    } finally {
      this.session = null
      this.updateState({ connected: false, speaking: "none" })
      this.onEvent?.({ type: "session_ended", reason: "cancelled" })
      this.onEvent = null
    }
  }

  sendAudio(audioData: Buffer): void {
    if (!this.session) {
      this.log.warn("Cannot send audio: session not connected")
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
   */
  private buildLiveConfig(config: VoiceProviderConfig): LiveConnectConfig {
    const liveConfig: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    }

    // Voice selection
    if (config.voiceName) {
      liveConfig.speechConfig = {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: config.voiceName,
          },
        },
      }
    }

    // Language
    if (config.language && liveConfig.speechConfig) {
      liveConfig.speechConfig.languageCode = config.language
    } else if (config.language) {
      liveConfig.speechConfig = {
        languageCode: config.language,
      }
    }

    // System instruction
    if (config.systemInstruction) {
      liveConfig.systemInstruction = config.systemInstruction
    }

    // Enable context window compression for long conversations
    liveConfig.contextWindowCompression = {
      slidingWindow: {
        targetTokens: "10000",
      },
    }

    // Enable session resumption
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
