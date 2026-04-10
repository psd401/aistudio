/**
 * Audio Visualizer — Pulsing Orb
 *
 * Displays a pulsing orb that reacts to real-time audio volume.
 * Uses CSS transforms for smooth 60fps animation without layout thrashing.
 * Respects prefers-reduced-motion for vestibular accessibility.
 *
 * States:
 * - Connecting: spinning animation
 * - Listening: blue orb, pulses with user mic volume
 * - Speaking: purple orb, pulses with AI audio volume
 * - Error: red orb
 *
 * Issue #873
 */

'use client'

import { memo } from 'react'
import { cn } from '@/lib/utils'

export type VisualizerMode = 'connecting' | 'listening' | 'speaking' | 'error' | 'idle'

interface AudioVisualizerProps {
  /** Current voice session mode */
  mode: VisualizerMode
  /** Audio volume level 0–1 */
  volume: number
}

/** Base size of the orb in pixels */
const ORB_BASE_SIZE = 120

/** How much the orb scales with volume (1.0 = base, 1.4 = 40% larger at max volume) */
const MAX_SCALE = 1.4

/** Number of concentric rings around the orb */
const RING_COUNT = 3

/** Pre-computed ring configuration (static — no need for useMemo) */
const RINGS = Array.from({ length: RING_COUNT }, (_, i) => ({
  offset: (i + 1) * 20,
  opacity: 0.15 - i * 0.04,
  delay: i * 0.1,
}))

const modeColors: Record<VisualizerMode, { orb: string; ring: string; glow: string }> = {
  idle: {
    orb: 'bg-gray-400',
    ring: 'border-gray-300/30',
    glow: 'shadow-gray-400/20',
  },
  connecting: {
    orb: 'bg-blue-400',
    ring: 'border-blue-300/30',
    glow: 'shadow-blue-400/30',
  },
  listening: {
    orb: 'bg-blue-500',
    ring: 'border-blue-400/25',
    glow: 'shadow-blue-500/30',
  },
  speaking: {
    orb: 'bg-purple-500',
    ring: 'border-purple-400/25',
    glow: 'shadow-purple-500/30',
  },
  error: {
    orb: 'bg-red-500',
    ring: 'border-red-400/25',
    glow: 'shadow-red-500/30',
  },
}

export const AudioVisualizer = memo(function AudioVisualizer({
  mode,
  volume,
}: AudioVisualizerProps) {
  const colors = modeColors[mode]
  const isConnecting = mode === 'connecting'

  // Scale based on volume (smoother transition with easing)
  const scale = 1 + volume * (MAX_SCALE - 1)

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: ORB_BASE_SIZE + RING_COUNT * 40, height: ORB_BASE_SIZE + RING_COUNT * 40 }}
      role="img"
      aria-label={`Voice visualizer: ${mode}`}
    >
      {/* Concentric rings — animations disabled for prefers-reduced-motion */}
      {RINGS.map((ring, i) => (
        <div
          key={i}
          className={cn(
            'absolute rounded-full border-2 transition-transform duration-150 motion-reduce:transition-none',
            colors.ring,
            isConnecting && 'animate-ping motion-reduce:animate-none'
          )}
          style={{
            width: ORB_BASE_SIZE + ring.offset * 2,
            height: ORB_BASE_SIZE + ring.offset * 2,
            opacity: ring.opacity + volume * 0.1,
            transform: `scale(${1 + volume * 0.15 * (i + 1)})`,
            animationDelay: isConnecting ? `${ring.delay}s` : undefined,
            animationDuration: isConnecting ? '1.5s' : undefined,
          }}
        />
      ))}

      {/* Main orb — reduced-motion users get static orb */}
      <div
        className={cn(
          'relative rounded-full transition-transform duration-100 motion-reduce:transition-none',
          colors.orb,
          colors.glow,
          'shadow-2xl',
          isConnecting && 'animate-pulse motion-reduce:animate-none'
        )}
        style={{
          width: ORB_BASE_SIZE,
          height: ORB_BASE_SIZE,
          transform: isConnecting ? undefined : `scale(${scale})`,
        }}
      >
        {/* Inner highlight for depth */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(circle at 35% 35%, rgba(255,255,255,0.3) 0%, transparent 60%)',
          }}
        />
      </div>
    </div>
  )
})
