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
  /** Called BEFORE connect() — sets up the adapter with conversationId */
  onVoiceStart: () => void
}

/**
 * Disabled Voice Mode Button — shown when voice is unavailable.
 * Displays a disabled mic with a tooltip explaining why (e.g., role or admin setting).
 * Issue #876 — reviewer feedback: render reason in the UI.
 */
export function DisabledVoiceButton({ reason }: { reason: string }) {
  return (
    <TooltipIconButton
      tooltip={reason}
      variant="ghost"
      className="text-muted-foreground opacity-50 cursor-not-allowed"
      disabled
      aria-label={reason}
      data-testid="voice-mode-button-disabled"
    >
      <Mic className="size-5" />
    </TooltipIconButton>
  )
}

export function VoiceButton({ onVoiceStart }: VoiceButtonProps) {
  const controls = useVoiceControls()
  const voiceState = useVoiceState()

  const isVoiceActive = voiceState?.status?.type === 'starting' || voiceState?.status?.type === 'running'

  // onVoiceStart is synchronous (swaps adapter via flushSync), so connect()
  // immediately uses the correct adapter. No async window = no race condition.
  const handleClick = useCallback(() => {
    onVoiceStart()
    controls.connect()
  }, [controls, onVoiceStart])

  return (
    <TooltipIconButton
      tooltip="Voice mode"
      variant="ghost"
      className="text-muted-foreground hover:text-foreground"
      onClick={handleClick}
      disabled={isVoiceActive}
      aria-label="Start voice conversation"
      data-testid="voice-mode-button"
    >
      <Mic className="size-5" />
    </TooltipIconButton>
  )
}
