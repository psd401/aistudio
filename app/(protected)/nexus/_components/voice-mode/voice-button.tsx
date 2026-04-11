/**
 * Voice Mode Button — Composer action button to start voice mode
 *
 * Placed in the composer action bar via the composerExtraActions slot.
 * Uses useVoiceControls from assistant-ui to initiate the voice session.
 *
 * Issue #873
 */

'use client'

import { useCallback, useRef, useState } from 'react'
import { useVoiceControls, useVoiceState } from '@assistant-ui/react'
import { Loader2, Mic } from 'lucide-react'
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'

interface VoiceButtonProps {
  /**
   * Called BEFORE connect() — must complete adapter setup (context fetch + adapter swap)
   * before the voice runtime initiates the WebSocket connection.
   * Returns a promise that resolves when the adapter is ready.
   */
  onVoiceStart: () => Promise<void>
}

export function VoiceButton({ onVoiceStart }: VoiceButtonProps) {
  const controls = useVoiceControls()
  const voiceState = useVoiceState()

  // Loading state tracks the async context-fetch window between button click and
  // controls.connect(). This disables the button and shows a spinner so users know
  // something is happening during the fetch (which can take 500ms+ on slow networks).
  const [isLoading, setIsLoading] = useState(false)

  // Guard against double-clicks during the async context-fetch window.
  // voiceState.status only transitions to 'starting' after controls.connect(),
  // so there's a gap while onVoiceStart() awaits the network fetch where a second
  // click would create a duplicate adapter and race two connect() calls.
  const isStartingRef = useRef(false)

  const isVoiceActive = voiceState?.status?.type === 'starting' || voiceState?.status?.type === 'running'

  // Await onVoiceStart (which fetches context and swaps the adapter) BEFORE calling
  // controls.connect(). This ensures the connect() call uses the context-aware adapter,
  // not the initial no-context adapter. The overlay opens immediately showing "Connecting..."
  // state. If connect rejects, useVoiceState transitions to 'ended' with error.
  const handleClick = useCallback(async () => {
    if (isStartingRef.current) return
    isStartingRef.current = true
    setIsLoading(true)
    try {
      await onVoiceStart()
      controls.connect()
    } finally {
      isStartingRef.current = false
      setIsLoading(false)
    }
  }, [controls, onVoiceStart])

  return (
    <TooltipIconButton
      tooltip={isLoading ? 'Preparing voice...' : 'Voice mode'}
      variant="ghost"
      className="text-muted-foreground hover:text-foreground"
      onClick={handleClick}
      disabled={isVoiceActive || isLoading}
      aria-label={isLoading ? 'Preparing voice session' : 'Start voice conversation'}
      data-testid="voice-mode-button"
    >
      {isLoading ? <Loader2 className="size-5 animate-spin" /> : <Mic className="size-5" />}
    </TooltipIconButton>
  )
}
