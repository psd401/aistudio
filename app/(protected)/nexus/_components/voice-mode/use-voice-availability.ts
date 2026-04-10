/**
 * Hook to check voice mode availability for the current user.
 *
 * Fetches GET /api/nexus/voice to verify:
 * - User has hasToolAccess("voice-mode") permission
 * - Voice provider is configured (API key exists)
 * - Returns WebSocket connection info (port, path)
 *
 * Issue #873
 */

'use client'

import { useState, useEffect } from 'react'

export interface VoiceAvailability {
  /** Whether voice mode is available for this user */
  available: boolean
  /** Whether the check is still loading */
  loading: boolean
  /** WebSocket port for voice connections */
  wsPort: number | null
  /** WebSocket path */
  wsPath: string | null
}

/**
 * Checks voice mode availability. Only fetches once per mount.
 * Aborts fetch on unmount to prevent stale setState calls.
 * Returns { available: false } on any error (fail-closed).
 */
export function useVoiceAvailability(): VoiceAvailability {
  const [state, setState] = useState<VoiceAvailability>({
    available: false,
    loading: true,
    wsPort: null,
    wsPath: null,
  })

  useEffect(() => {
    const controller = new AbortController()

    fetch('/api/nexus/voice', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) {
          setState({ available: false, loading: false, wsPort: null, wsPath: null })
          return
        }
        return res.json()
      })
      .then((data) => {
        if (data) {
          setState({
            available: !!data.available,
            loading: false,
            wsPort: data.wsPort ?? null,
            wsPath: data.wsPath ?? null,
          })
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ available: false, loading: false, wsPort: null, wsPath: null })
        }
      })

    return () => { controller.abort() }
  }, [])

  return state
}
