/**
 * Voice Provider Module
 *
 * Server-side voice provider abstraction for real-time voice conversations.
 * Issue #872
 */

export type {
  VoiceProvider,
  VoiceProviderConfig,
  VoiceProviderEvent,
  VoiceProviderEventHandler,
  VoiceSessionState,
  TranscriptEntry,
  VoiceClientMessage,
  VoiceServerMessage,
} from "./types"

export { GeminiLiveProvider } from "./gemini-live-provider"
export { createVoiceProvider } from "./provider-factory"
export { saveVoiceTranscript } from "./transcript-service"
export type { TranscriptSaveResult } from "./transcript-service"
