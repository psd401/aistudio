"use client"

import { useEffect, useRef, useCallback } from "react"

interface UsePollingWithBackoffOptions {
  /** Base polling interval in milliseconds */
  baseInterval: number
  /** Maximum backoff multiplier (default: 8) */
  maxMultiplier?: number
  /** Whether polling is enabled (default: true). Failures reset when this transitions to true. */
  enabled?: boolean
}

/**
 * Shared polling hook with exponential backoff on failures.
 *
 * Calls `fn` on a recurring interval. On success (promise resolves), resets backoff.
 * On failure (promise rejects), applies 2^failures multiplier (capped at maxMultiplier)
 * with ±10% jitter to prevent thundering herd.
 *
 * The caller's `fn` should re-throw errors it wants the hook to track for backoff.
 * Caught-and-swallowed errors won't trigger backoff.
 *
 * Guards against concurrent polling calls via an internal loading ref. Manual calls
 * to the same `fn` outside the hook are not guarded (concurrent GET is harmless).
 */
export function usePollingWithBackoff(
  fn: () => Promise<unknown>,
  options: UsePollingWithBackoffOptions
) {
  const { baseInterval, maxMultiplier = 8, enabled = true } = options
  const consecutiveFailures = useRef(0)
  const isLoadingRef = useRef(false)

  const resetFailures = useCallback(() => {
    consecutiveFailures.current = 0
  }, [])

  useEffect(() => {
    if (!enabled || baseInterval <= 0) {
      return
    }

    // Reset failures when polling becomes enabled (e.g., re-authentication)
    consecutiveFailures.current = 0

    let cancelled = false

    const getInterval = () => {
      const base = consecutiveFailures.current === 0
        ? baseInterval
        : Math.min(Math.pow(2, consecutiveFailures.current), maxMultiplier) * baseInterval
      // ±10% jitter to prevent thundering herd from multiple tabs retrying simultaneously
      const jitter = Math.random() * 0.2 + 0.9
      return base * jitter
    }

    let timeoutId: NodeJS.Timeout

    const scheduleNext = () => {
      if (cancelled) return
      timeoutId = setTimeout(() => {
        if (cancelled) return
        if (!isLoadingRef.current) {
          isLoadingRef.current = true
          fn()
            .then(() => {
              consecutiveFailures.current = 0
            })
            .catch(() => {
              consecutiveFailures.current++
            })
            .finally(() => {
              isLoadingRef.current = false
              if (!cancelled) scheduleNext()
            })
        } else {
          // Fetch still in flight — wait another full interval before rechecking.
          // This means polling skips at most one cycle when a request runs long.
          scheduleNext()
        }
      }, getInterval())
    }

    scheduleNext()

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [fn, baseInterval, maxMultiplier, enabled])

  return { resetFailures }
}
