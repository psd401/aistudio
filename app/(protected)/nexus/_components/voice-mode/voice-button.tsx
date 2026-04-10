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
  /** Called after connect() to open the voice overlay */
  onVoiceStart: () => void
}

export function VoiceButton({ onVoiceStart }: VoiceButtonProps) {
  const controls = useVoiceControls()
  const voiceState = useVoiceState()

  // Guard against double-clicks: disable while connecting or running
  const isActive = voiceState?.status?.type === 'starting' || voiceState?.status?.type === 'running'

  const handleClick = useCallback(() => {
    controls.connect()
    onVoiceStart()
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
