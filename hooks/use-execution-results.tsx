"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useSession } from "next-auth/react"
import { createLogger, generateRequestId } from "@/lib/client-logger"
import type { ExecutionResult } from "@/types/notifications"

interface UseExecutionResultsOptions {
  limit?: number
  status?: 'success' | 'failed' | 'running'
  refreshInterval?: number
}

export function useExecutionResults(options: UseExecutionResultsOptions = {}) {
  const {
    limit = 20,
    status,
    refreshInterval = 60000 // 1 minute
  } = options

  const { status: sessionStatus } = useSession()
  const [results, setResults] = useState<ExecutionResult[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const consecutiveFailures = useRef(0)
  const isLoadingRef = useRef(false)

  const fetchResults = useCallback(async () => {
    // Don't fetch if session is not authenticated
    if (sessionStatus !== 'authenticated') {
      return
    }

    const requestId = generateRequestId()
    const requestLog = createLogger({ hook: 'useExecutionResults', requestId })

    isLoadingRef.current = true
    try {
      setError(null)

      const params = new URLSearchParams({
        limit: limit.toString(),
        ...(status && { status })
      })

      const response = await fetch(`/api/execution-results/recent?${params}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        // Session expired — silently stop, don't treat as error
        if (response.status === 401) {
          setResults([])
          // Belt-and-suspenders: `finally` always runs after this return, so these
          // assignments are redundant. They're kept here to make the early-return
          // intent explicit for readers who may not notice the `finally` block.
          isLoadingRef.current = false
          setIsLoading(false)
          return
        }
        throw new Error(`Failed to fetch execution results: ${response.status}`)
      }

      const data = await response.json()

      if (!data.isSuccess) {
        throw new Error(data.message || 'Failed to fetch execution results')
      }

      setResults(data.data || [])
      consecutiveFailures.current = 0
      requestLog.info('Execution results fetched successfully', {
        count: data.data?.length || 0
      })
    } catch (err) {
      consecutiveFailures.current++
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      // Downgrade to warn — polling failures are expected transient states
      requestLog.warn('Failed to fetch execution results', {
        error: errorMessage,
        consecutiveFailures: consecutiveFailures.current
      })
      setError(errorMessage)
    } finally {
      isLoadingRef.current = false
      setIsLoading(false)
    }
  }, [limit, status, sessionStatus])

  const refreshResults = useCallback(async () => {
    await fetchResults()
  }, [fetchResults])

  // Reset state when session becomes unauthenticated to prevent stuck loading spinner.
  // sessionStatus === 'loading' intentionally keeps isLoading=true while NextAuth resolves auth.
  useEffect(() => {
    if (sessionStatus === 'unauthenticated') {
      setResults([])
      setIsLoading(false)
      setError(null)
      consecutiveFailures.current = 0
    }
  }, [sessionStatus])

  // Initial fetch on mount (only when authenticated); reset backoff on re-authentication
  useEffect(() => {
    if (sessionStatus === 'authenticated') {
      consecutiveFailures.current = 0
      fetchResults()
    }
  }, [fetchResults, sessionStatus])

  // Set up periodic refresh with exponential backoff on failures
  useEffect(() => {
    if (refreshInterval <= 0 || sessionStatus !== 'authenticated') {
      return
    }

    let cancelled = false

    const getInterval = () => {
      const base = consecutiveFailures.current === 0
        ? refreshInterval
        : Math.min(Math.pow(2, consecutiveFailures.current), 8) * refreshInterval
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
          // Use .finally() so polling continues on both success and transient errors
          fetchResults().finally(() => {
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
  }, [fetchResults, refreshInterval, sessionStatus])

  return {
    results,
    isLoading,
    error,
    refreshResults,
  }
}
