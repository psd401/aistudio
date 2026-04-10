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

import { useState, useEffect, useRef } from 'react'

interface VoiceAvailability {
  /** Whether voice mode is available for this user */
  available: boolean
  /** Whether the check is still loading */
  loading: boolean
}

/**
 * Checks voice mode availability. Only fetches once per mount.
 * Returns { available: false, loading: false } on any error (fail-closed).
 */
export function useVoiceAvailability(): VoiceAvailability {
  const [state, setState] = useState<VoiceAvailability>({ available: false, loading: true })
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true

    fetch('/api/nexus/voice')
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
        setState({ available: false, loading: false })
      })
  }, [])

  return state
}
