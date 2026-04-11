/**
 * Voice Session Lifecycle Hook
 *
 * Manages the complete voice session lifecycle:
 * - Building conversation context (system instruction from prior messages)
 * - Creating voice adapter with conversation context
 * - Handling browser navigation cleanup (beforeunload)
 * - Coordinating between voice UI and Nexus page state
 *
 * Does NOT manage the audio/WebSocket connection directly — that's handled
 * by the GeminiLiveVoiceAdapter and assistant-ui's voice runtime.
 *
 * Issue #874
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeVoiceAdapter } from '@assistant-ui/react'
import { createGeminiLiveVoiceAdapter } from './gemini-live-voice-adapter'
import { buildVoiceSystemInstruction, fetchConversationContext } from './voice-context-builder'
import { createLogger } from '@/lib/client-logger'

const log = createLogger({ moduleName: 'use-voice-session' })

/** Max number of recent messages to include in voice context */
const MAX_CONTEXT_MESSAGES = 20

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
  /** Called when user clicks voice button — fetches context and opens overlay */
  handleVoiceStart: () => void
  /** Called when voice overlay closes */
  handleVoiceClose: () => void
}

/**
 * Hook that manages voice session lifecycle including conversation context.
 *
 * The key insight: the voice adapter must be recreated when the user starts
 * a voice session (not on every conversationId change) because the system
 * instruction is baked into the adapter at creation time and passed to the
 * Gemini Live session during the WebSocket handshake.
 *
 * Flow:
 * 1. User clicks voice button
 * 2. Hook fetches recent conversation messages (if conversationId exists)
 * 3. Builds system instruction from messages
 * 4. Creates new adapter with conversation context
 * 5. Opens voice overlay
 * 6. assistant-ui calls adapter.connect() which starts the WebSocket session
 */
export function useVoiceSession({
  voiceAvailable,
  conversationId,
}: UseVoiceSessionOptions): UseVoiceSessionResult {
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false)
  const [voiceAdapter, setVoiceAdapter] = useState<RealtimeVoiceAdapter | undefined>(undefined)

  // Track conversationId via ref so the async callback reads the latest value
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId

  // Create initial adapter (no context) when voice becomes available
  useEffect(() => {
    if (voiceAvailable) {
      setVoiceAdapter(createGeminiLiveVoiceAdapter())
    } else {
      setVoiceAdapter(undefined)
    }
  }, [voiceAvailable])

  // Handle voice button click — fetch context and recreate adapter
  const handleVoiceStart = useCallback(async () => {
    if (!voiceAvailable) return

    const currentConversationId = conversationIdRef.current
    let systemInstruction: string | undefined

    // If there's an existing conversation, fetch messages for context
    if (currentConversationId) {
      try {
        log.info('Fetching conversation context for voice session', {
          conversationId: currentConversationId,
        })
        const messages = await fetchConversationContext(
          currentConversationId,
          MAX_CONTEXT_MESSAGES,
        )
        if (messages.length > 0) {
          systemInstruction = buildVoiceSystemInstruction({ priorMessages: messages })
          log.info('Built voice system instruction from conversation context', {
            messageCount: messages.length,
            instructionLength: systemInstruction.length,
          })
        }
      } catch (error) {
        // Non-fatal: voice works without context, just log and continue
        log.warn('Failed to fetch conversation context for voice', {
          conversationId: currentConversationId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Create adapter with conversation context
    setVoiceAdapter(createGeminiLiveVoiceAdapter({
      conversationId: currentConversationId ?? undefined,
      systemInstruction,
    }))

    setVoiceOverlayOpen(true)
  }, [voiceAvailable])

  const handleVoiceClose = useCallback(() => {
    setVoiceOverlayOpen(false)
  }, [])

  // Browser navigation cleanup — log warning for debugging
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (voiceOverlayOpen) {
        log.info('Page unloading while voice session active')
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [voiceOverlayOpen])

  return useMemo(
    () => ({
      voiceAdapter,
      voiceOverlayOpen,
      handleVoiceStart,
      handleVoiceClose,
    }),
    [voiceAdapter, voiceOverlayOpen, handleVoiceStart, handleVoiceClose],
  )
}
