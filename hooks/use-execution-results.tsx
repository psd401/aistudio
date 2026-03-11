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

  // Initial fetch on mount (only when authenticated)
  useEffect(() => {
    if (sessionStatus === 'authenticated') {
      fetchResults()
    }
  }, [fetchResults, sessionStatus])

  // Set up periodic refresh with exponential backoff on failures
  useEffect(() => {
    if (refreshInterval <= 0 || sessionStatus !== 'authenticated') {
      return
    }

    const getInterval = () => {
      if (consecutiveFailures.current === 0) return refreshInterval
      // Exponential backoff: 1x, 2x, 4x, 8x cap
      const multiplier = Math.min(Math.pow(2, consecutiveFailures.current), 8)
      return refreshInterval * multiplier
    }

    let timeoutId: NodeJS.Timeout

    const scheduleNext = () => {
      timeoutId = setTimeout(() => {
        if (!isLoadingRef.current) {
          fetchResults().then(scheduleNext)
        } else {
          scheduleNext()
        }
      }, getInterval())
    }

    scheduleNext()

    return () => clearTimeout(timeoutId)
  }, [fetchResults, refreshInterval, sessionStatus])

  return {
    results,
    isLoading,
    error,
    refreshResults,
  }
}
