"use client"

import { useState, useEffect, useCallback } from "react"
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

  const [results, setResults] = useState<ExecutionResult[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchResults = useCallback(async () => {
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
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
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
      requestLog.error('Failed to fetch execution results', { error: errorMessage })
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }, [limit, status])

  const refreshResults = useCallback(async () => {
    await fetchResults()
  }, [fetchResults])

  // Initial fetch on mount
  useEffect(() => {
    fetchResults()
  }, [fetchResults])

  // Set up periodic refresh
  useEffect(() => {
    if (refreshInterval > 0) {
      const interval = setInterval(() => {
        if (!isLoading) {
          fetchResults()
        }
      }, refreshInterval)

      return () => clearInterval(interval)
    }
  }, [fetchResults, isLoading, refreshInterval])

  return {
    results,
    isLoading,
    error,
    refreshResults,
  }
}