/**
 * Hook to check voice mode availability for the current user.
 *
 * Fetches GET /api/nexus/voice/availability to verify:
 * - Global voice enabled setting (admin kill switch)
 * - User has hasToolAccess("voice-mode") permission
 * - Voice provider and model are configured
 * - Google API key exists
 *
 * Returns { available, loading, reason } — reason explains why voice
 * is unavailable (e.g., "Voice mode is disabled by administrator").
 *
 * Issue #873, #876
 */

'use client'

import { useState, useEffect } from 'react'

export interface VoiceAvailability {
  /** Whether voice mode is available for this user */
  available: boolean
  /** Whether the check is still loading */
  loading: boolean
  /** Human-readable reason when voice is not available */
  reason?: string
}

/**
 * Checks voice mode availability. Only fetches once per mount.
 * Aborts fetch on unmount to prevent stale setState calls.
 * Returns { available: false } on any error (fail-closed).
 */
export function useVoiceAvailability(): VoiceAvailability {
  const [state, setState] = useState<VoiceAvailability>({ available: false, loading: true })

  useEffect(() => {
    const controller = new AbortController()

    fetch('/api/nexus/voice/availability', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) {
          setState({ available: false, loading: false })
          return
        }
        return res.json()
      })
      .then((data) => {
        if (data && !controller.signal.aborted) {
          setState({
            available: !!data.available,
            loading: false,
            reason: data.reason,
          })
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ available: false, loading: false })
        }
      })

    return () => { controller.abort() }
  }, [])

  return state
}
