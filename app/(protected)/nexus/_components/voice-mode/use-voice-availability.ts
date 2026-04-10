/**
 * Hook to check voice mode availability for the current user.
 *
 * Fetches GET /api/nexus/voice to verify:
 * - User has hasToolAccess("voice-mode") permission
 * - Voice provider is configured (API key exists)
 *
 * Issue #873
 */

'use client'

import { useState, useEffect } from 'react'

interface VoiceAvailability {
  /** Whether voice mode is available for this user */
  available: boolean
  /** Whether the check is still loading */
  loading: boolean
}

/**
 * Checks voice mode availability. Only fetches once per mount.
 * Aborts fetch on unmount to prevent stale setState calls.
 * Returns { available: false, loading: false } on any error (fail-closed).
 */
export function useVoiceAvailability(): VoiceAvailability {
  const [state, setState] = useState<VoiceAvailability>({ available: false, loading: true })

  useEffect(() => {
    const controller = new AbortController()

    fetch('/api/nexus/voice', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) {
          setState({ available: false, loading: false })
          return
        }
        return res.json()
      })
      .then((data) => {
        if (data) {
          setState({ available: !!data.available, loading: false })
        }
      })
      .catch(() => {
        // AbortError from unmount or network error — fail closed
        if (!controller.signal.aborted) {
          setState({ available: false, loading: false })
        }
      })

    return () => { controller.abort() }
  }, [])

  return state
}
