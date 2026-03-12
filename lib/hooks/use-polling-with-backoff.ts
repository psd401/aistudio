"use client"

import { useEffect, useRef, useCallback } from "react"

interface UsePollingWithBackoffOptions {
  /** Base polling interval in milliseconds */
  baseInterval: number
  /** Maximum backoff multiplier (default: 8) */
  maxMultiplier?: number
  /**
   * Whether polling is enabled (default: true).
   *
   * Failures reset only on genuine false→true transition, not on fn/interval changes.
   * `fn` must be stable (wrapped in `useCallback`) to avoid unintentional backoff resets.
   */
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
  // Track whether polling was previously enabled to detect genuine false→true transitions
  const wasEnabledRef = useRef(false)

  const resetFailures = useCallback(() => {
    consecutiveFailures.current = 0
  }, [])

  useEffect(() => {
    if (!enabled || baseInterval <= 0) {
      wasEnabledRef.current = false
      return
    }

    // Only reset failures on genuine false→true transition, not fn/interval changes.
    // This prevents a non-memoized fn from silently defeating backoff mid-session.
    if (!wasEnabledRef.current) {
      consecutiveFailures.current = 0
    }
    wasEnabledRef.current = true

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
      // Reset the loading guard so the next effect run can poll immediately
      // without skipping the first cycle due to a stale in-flight flag.
      isLoadingRef.current = false
    }
  }, [fn, baseInterval, maxMultiplier, enabled])

  return { resetFailures, consecutiveFailures }
}
