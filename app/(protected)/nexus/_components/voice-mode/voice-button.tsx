/**
 * Voice Mode Button — Composer action button to start voice mode
 *
 * Placed in the composer action bar via the composerExtraActions slot.
 * Uses useVoiceControls from assistant-ui to initiate the voice session.
 *
 * Issue #873
 */

'use client'

import { useCallback } from 'react'
import { useVoiceControls, useVoiceState } from '@assistant-ui/react'
import { Mic } from 'lucide-react'
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

  // Guard against double-clicks: disable while connecting or running
  const isActive = voiceState?.status?.type === 'starting' || voiceState?.status?.type === 'running'

  // Await onVoiceStart (which fetches context and swaps the adapter) BEFORE calling
  // controls.connect(). This ensures the connect() call uses the context-aware adapter,
  // not the initial no-context adapter. The overlay opens immediately showing "Connecting..."
  // state. If connect rejects, useVoiceState transitions to 'ended' with error.
  const handleClick = useCallback(async () => {
    await onVoiceStart()
    controls.connect()
  }, [controls, onVoiceStart])

  return (
    <TooltipIconButton
      tooltip="Voice mode"
      variant="ghost"
      className="text-muted-foreground hover:text-foreground"
      onClick={handleClick}
      disabled={isActive}
      aria-label="Start voice conversation"
      data-testid="voice-mode-button"
    >
      <Mic className="size-5" />
    </TooltipIconButton>
  )
}
