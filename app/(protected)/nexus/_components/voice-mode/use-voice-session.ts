/**
 * Voice Session Lifecycle Hook
 *
 * Manages the complete voice session lifecycle:
 * - Creating voice adapter with conversation context
 * - Handling browser navigation cleanup (beforeunload)
 * - Coordinating between voice UI and Nexus page state
 *
 * System instruction building is done server-side (lib/voice/voice-instruction-builder.ts).
 * The client only passes the conversationId — the server fetches messages from DB,
 * verifies ownership, and builds the instruction.
 *
 * Issue #874
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { RealtimeVoiceAdapter } from '@assistant-ui/react'
import { createGeminiLiveVoiceAdapter } from './gemini-live-voice-adapter'
import { createLogger } from '@/lib/client-logger'

const log = createLogger({ moduleName: 'use-voice-session' })

export interface UseVoiceSessionOptions {
  /** Whether voice mode is available for this user */
  voiceAvailable: boolean
  /** Current conversation ID (null = new conversation) */
  conversationId: string | null
}

export interface UseVoiceSessionResult {
  /** The voice adapter to pass to useChatRuntime (undefined when unavailable) */
  voiceAdapter: RealtimeVoiceAdapter | undefined
  /** Whether the voice overlay should be shown */
  voiceOverlayOpen: boolean
  /** Called when user clicks voice button — creates adapter and opens overlay */
  handleVoiceStart: () => void
  /** Called when voice overlay closes */
  handleVoiceClose: () => void
}

/**
 * Hook that manages voice session lifecycle.
 *
 * The voice adapter is recreated when the user starts a voice session
 * (not on every conversationId change) because the conversationId is
 * baked into the adapter at creation time and sent to the server during
 * the WebSocket handshake. The server then builds the system instruction
 * from the conversation's messages.
 *
 * Flow:
 * 1. User clicks voice button
 * 2. Hook creates adapter with conversationId
 * 3. Opens voice overlay
 * 4. assistant-ui calls adapter.connect() which starts the WebSocket session
 * 5. Server receives conversationId, fetches messages, builds instruction
 */
export function useVoiceSession({
  voiceAvailable,
  conversationId,
}: UseVoiceSessionOptions): UseVoiceSessionResult {
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false)
  const [voiceAdapter, setVoiceAdapter] = useState<RealtimeVoiceAdapter | undefined>(undefined)

  // Track conversationId via ref so the callback reads the latest value
  const conversationIdRef = useRef(conversationId)
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  // Create initial adapter (no context) when voice becomes available.
  // This no-context adapter is required by useChatRuntime for registration purposes
  // but is never used for an actual voice session — handleVoiceStart always creates
  // a fresh adapter before controls.connect() is called.
  useEffect(() => {
    if (voiceAvailable) {
      setVoiceAdapter(createGeminiLiveVoiceAdapter())
    } else {
      setVoiceAdapter(undefined)
    }
  }, [voiceAvailable])

  // Handle voice button click — create adapter with conversationId and open overlay.
  // No client-side context fetching: the server builds the system instruction from DB.
  const handleVoiceStart = useCallback(() => {
    if (!voiceAvailable) return

    const currentConversationId = conversationIdRef.current

    log.info('Starting voice session', {
      hasConversation: !!currentConversationId,
    })

    // Create adapter with conversationId. flushSync forces the state update to
    // commit synchronously so the voice runtime has the new adapter when VoiceButton
    // calls controls.connect() immediately after. This is a known React 18+ footgun
    // (flushes all pending state), but assistant-ui requires the adapter to be in
    // state before connect() — there's no API to inject an adapter at connect-time.
    flushSync(() => {
      setVoiceAdapter(createGeminiLiveVoiceAdapter({
        conversationId: currentConversationId ?? undefined,
      }))
      setVoiceOverlayOpen(true)
    })
  }, [voiceAvailable])

  const handleVoiceClose = useCallback(() => {
    setVoiceOverlayOpen(false)
  }, [])

  // Browser navigation: intentionally passive — the WebSocket will close naturally
  // when the page unloads. This handler only logs for debugging purposes so we can
  // distinguish intentional disconnects from unexpected ones in production logs.
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (voiceOverlayOpen) {
        log.info('Page unloading while voice session active')
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [voiceOverlayOpen])

  return {
    voiceAdapter,
    voiceOverlayOpen,
    handleVoiceStart,
    handleVoiceClose,
  }
}
