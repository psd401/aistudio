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
import { useVoiceControls } from '@assistant-ui/react'
import { Mic } from 'lucide-react'
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'

interface VoiceButtonProps {
  /** Called after connect() to open the voice overlay */
  onVoiceStart: () => void
}

export function VoiceButton({ onVoiceStart }: VoiceButtonProps) {
  const controls = useVoiceControls()

  const handleClick = useCallback(() => {
    // eslint-disable-next-line no-console -- temporary debug for voice session startup
    console.log('[VoiceButton] clicked, calling controls.connect()', controls)
    try {
      controls.connect()
      // eslint-disable-next-line no-console -- temporary debug
      console.log('[VoiceButton] connect() called successfully')
    } catch (err) {
      // eslint-disable-next-line no-console -- temporary debug
      console.error('[VoiceButton] connect() threw:', err)
    }
    onVoiceStart()
  }, [controls, onVoiceStart])

  return (
    <TooltipIconButton
      tooltip="Voice mode"
      variant="ghost"
      className="text-muted-foreground hover:text-foreground"
      onClick={handleClick}
      aria-label="Start voice conversation"
      data-testid="voice-mode-button"
    >
      <Mic className="size-5" />
    </TooltipIconButton>
  )
}
