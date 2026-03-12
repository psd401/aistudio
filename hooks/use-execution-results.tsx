"use client"

import { useState, useEffect, useCallback } from "react"
import { useSession } from "next-auth/react"
import { createLogger, generateRequestId } from "@/lib/client-logger"
import { usePollingWithBackoff } from "@/lib/hooks/use-polling-with-backoff"
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

  const fetchResults = useCallback(async () => {
    // Don't fetch if session is not authenticated
    if (sessionStatus !== 'authenticated') {
      return
    }

    const requestId = generateRequestId()
    const requestLog = createLogger({ hook: 'useExecutionResults', requestId })

    try {
      setError(null)

      const params = new URLSearchParams({
        limit: limit.toString(),
        ...(status && { status })
      })

      const response = await fetch(`/api/execution-results/recent?${params}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!response.ok) {
        // 401 returns without throwing — polling hook treats this as success (no backoff increment).
        // Session expiry should not trigger exponential backoff.
        if (response.status === 401) {
          setResults([])
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
      requestLog.info('Execution results fetched successfully', {
        count: data.data?.length || 0
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      // Downgrade to warn — polling failures are expected transient states
      requestLog.warn('Failed to fetch execution results', {
        error: errorMessage,
        consecutiveFailures: consecutiveFailures.current
      })
      setError(errorMessage)
      throw err // Re-throw so the polling hook tracks the failure for backoff
    } finally {
      setIsLoading(false)
    }
  }, [limit, status, sessionStatus])

  const { resetFailures, consecutiveFailures } = usePollingWithBackoff(fetchResults, {
    baseInterval: refreshInterval,
    enabled: sessionStatus === 'authenticated',
  })

  // Reset state when session becomes unauthenticated to prevent stuck loading spinner.
  // sessionStatus === 'loading' intentionally keeps isLoading=true while NextAuth resolves auth.
  useEffect(() => {
    if (sessionStatus === 'unauthenticated') {
      setResults([])
      setIsLoading(false)
      setError(null)
      resetFailures()
    }
  }, [sessionStatus, resetFailures])

  // Initial fetch on mount (only when authenticated)
  useEffect(() => {
    if (sessionStatus === 'authenticated') {
      fetchResults().catch(() => {}) // Error already logged inside fetchResults
    }
  }, [fetchResults, sessionStatus])

  return {
    results,
    isLoading,
    error,
    refreshResults: useCallback(async () => {
      await fetchResults().catch(() => {}) // Error already logged inside fetchResults
    }, [fetchResults]),
  }
}
