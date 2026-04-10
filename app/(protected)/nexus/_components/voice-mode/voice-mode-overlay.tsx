/**
 * Voice Mode Overlay — Full-screen immersive voice conversation UI
 *
 * Displays when voice mode is active, showing:
 * - Pulsing orb audio visualization
 * - Current state label (Connecting, Listening, Speaking, Error)
 * - Mute/unmute toggle
 * - End conversation button
 *
 * Uses assistant-ui hooks: useVoiceState, useVoiceVolume, useVoiceControls
 *
 * Issue #873
 */

'use client'

import { useCallback, useEffect, type FC } from 'react'
import { useVoiceState, useVoiceVolume, useVoiceControls } from '@assistant-ui/react'
import { motion, AnimatePresence } from 'framer-motion'
import { Mic, MicOff, PhoneOff, AlertCircle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AudioVisualizer, type VisualizerMode } from './audio-visualizer'

interface VoiceModeOverlayProps {
  /** Whether the overlay is visible */
  open: boolean
  /** Called when the overlay should close */
  onClose: () => void
}

/** Maps voice session state to visualizer mode */
function getVisualizerMode(
  statusType: string | undefined,
  voiceMode: string | undefined,
  hasError: boolean
): VisualizerMode {
  if (!statusType) return 'idle'
  if (statusType === 'starting') return 'connecting'
  if (statusType === 'ended') return hasError ? 'error' : 'idle'
  if (voiceMode === 'speaking') return 'speaking'
  return 'listening'
}

/** Human-readable status label */
function getStatusLabel(
  statusType: string | undefined,
  voiceMode: string | undefined,
  isMuted: boolean
): string {
  if (!statusType) return 'Ready'
  if (statusType === 'starting') return 'Connecting...'
  if (statusType === 'ended') return 'Disconnected'
  if (isMuted) return 'Muted'
  if (voiceMode === 'speaking') return 'AI is speaking...'
  return 'Listening...'
}

/** Voice session control buttons — extracted to reduce parent complexity */
const VoiceControls: FC<{
  statusType: string | undefined
  isEnded: boolean
  isMuted: boolean
  onToggleMute: () => void
  onReconnect: () => void
  onDisconnect: () => void
}> = ({ statusType, isEnded, isMuted, onToggleMute, onReconnect, onDisconnect }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay: 0.4 }}
    className="mt-12 flex items-center gap-6"
  >
    {statusType === 'running' && (
      <Button
        variant="ghost"
        size="lg"
        onClick={onToggleMute}
        className="h-14 w-14 rounded-full border border-gray-700 bg-gray-800/50 text-gray-300 hover:bg-gray-700/50 hover:text-white"
        aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
      >
        {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
      </Button>
    )}

    {isEnded && (
      <Button
        variant="ghost"
        size="lg"
        onClick={onReconnect}
        className="h-14 w-14 rounded-full border border-gray-700 bg-gray-800/50 text-gray-300 hover:bg-gray-700/50 hover:text-white"
        aria-label="Reconnect"
      >
        <RotateCcw size={24} />
      </Button>
    )}

    <Button
      variant="destructive"
      size="lg"
      onClick={onDisconnect}
      className="h-14 min-w-[160px] rounded-full bg-red-600 text-white hover:bg-red-700"
      aria-label="End voice conversation"
    >
      <PhoneOff size={20} className="mr-2" />
      End Conversation
    </Button>
  </motion.div>
)

export function VoiceModeOverlay({ open, onClose }: VoiceModeOverlayProps) {
  const voiceState = useVoiceState()
  const volume = useVoiceVolume()
  const controls = useVoiceControls()

  const statusType = voiceState?.status?.type
  const isMuted = voiceState?.isMuted ?? false
  const voiceMode = voiceState?.mode
  const isEnded = statusType === 'ended'
  const endedError = isEnded
    ? (voiceState?.status as { type: 'ended'; error?: unknown }).error
    : null

  const vizMode = getVisualizerMode(statusType, voiceMode, endedError != null)
  const statusLabel = getStatusLabel(statusType, voiceMode, isMuted)

  const handleDisconnect = useCallback(() => {
    controls.disconnect()
    onClose()
  }, [controls, onClose])

  // Escape key disconnects and closes — guarded to avoid disconnecting an already-ended session
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (statusType !== 'ended') controls.disconnect()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, controls, onClose, statusType])

  const handleReconnect = useCallback(() => {
    controls.connect()
  }, [controls])

  const handleToggleMute = useCallback(() => {
    if (isMuted) {
      controls.unmute()
    } else {
      controls.mute()
    }
  }, [isMuted, controls])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-gray-950/95 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Voice conversation"
        >
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="absolute top-8 text-center sm:top-12"
          >
            <p className="text-sm font-medium text-gray-400 uppercase tracking-wider">
              Voice Mode
            </p>
          </motion.div>

          {/* Audio visualizer */}
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 20 }}
          >
            <AudioVisualizer mode={vizMode} volume={volume} />
          </motion.div>

          {/* State label — aria-live for screen reader announcements */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="mt-8 text-lg font-medium text-gray-200"
            aria-live="polite"
            aria-atomic="true"
          >
            {statusLabel}
          </motion.p>

          {/* Error message */}
          {isEnded && endedError != null && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 flex items-center gap-2 rounded-lg bg-red-950/50 px-4 py-2 text-sm text-red-300"
            >
              <AlertCircle size={16} />
              <span>Something went wrong. Please try again.</span>
            </motion.div>
          )}

          {/* Controls */}
          <VoiceControls
            statusType={statusType}
            isEnded={isEnded}
            isMuted={isMuted}
            onToggleMute={handleToggleMute}
            onReconnect={handleReconnect}
            onDisconnect={handleDisconnect}
          />

          {/* Keyboard shortcut hint */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="absolute bottom-6 text-xs text-gray-400"
          >
            Press Escape to end conversation
          </motion.p>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
