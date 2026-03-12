"use client"

import { useEffect, useRef, useCallback } from "react"

interface UsePollingWithBackoffOptions {
  /** Base polling interval in milliseconds */
  baseInterval: number
  /**
   * Maximum backoff multiplier (default: 8, minimum clamped to 1).
   * A value ≤ 0 would produce 0ms delays and tight-loop the event loop.
   */
  maxMultiplier?: number
  /**
   * Whether polling is enabled (default: true).
   *
   * Failures reset only on genuine false→true transition, not on fn/interval changes.
   * `fn` must be stable (wrapped in `useCallback`) to avoid unintentional backoff resets.
   */
  enabled?: boolean
  /**
   * Called after each polling failure with the post-increment consecutive failure count.
   * Use this for logging backoff depth — the count is accurate at call time.
   *
   * Does NOT need to be memoized — the hook wraps it in a ref internally so passing
   * an inline arrow function does not restart the polling chain on each render.
   */
  onFailure?: (consecutiveFailures: number) => void
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
  const { baseInterval, enabled = true, onFailure } = options
  // Clamp maxMultiplier to ≥1 — a value of 0 or negative would produce 0ms intervals
  // and spin the event loop continuously.
  const maxMultiplier = Math.max(1, options.maxMultiplier ?? 8)
  const consecutiveFailures = useRef(0)
  const isLoadingRef = useRef(false)
  // Track whether polling was previously enabled to detect genuine false→true transitions
  const wasEnabledRef = useRef(false)
  // Wrap onFailure in a ref so callers don't need to memoize it — an inline arrow
  // function in the caller would otherwise restart the polling chain on every render.
  const onFailureRef = useRef(onFailure)
  useEffect(() => { onFailureRef.current = onFailure })

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
        : Math.min(2 ** consecutiveFailures.current, maxMultiplier) * baseInterval
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
              // Notify caller with post-increment count so logging reflects the actual
              // depth the client is now at, with no +1 arithmetic needed by the caller.
              onFailureRef.current?.(consecutiveFailures.current)
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

  return { resetFailures }
}
