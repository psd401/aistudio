"use client"

import { useState, useCallback, useRef } from "react"
import type { SelectAiModel } from "@/types"

interface ComparisonState {
  model1: string
  model2: string
  error1?: string
  error2?: string
}

interface LoadingState {
  model1: boolean
  model2: boolean
}

interface StreamComparisonParams {
  prompt: string
  model1: SelectAiModel
  model2: SelectAiModel
}

export function useComparison() {
  const [responses, setResponses] = useState<ComparisonState>({
    model1: "",
    model2: ""
  })

  const [isLoading, setIsLoading] = useState<LoadingState>({
    model1: false,
    model2: false
  })

  const abortControllerRef = useRef<{
    model1?: AbortController
    model2?: AbortController
  }>({})

  const streamComparison = useCallback(async ({
    prompt,
    model1,
    model2
  }: StreamComparisonParams) => {
    // Reset state
    setResponses({ model1: "", model2: "" })
    setIsLoading({ model1: true, model2: true })

    // Create new abort controllers
    abortControllerRef.current = {
      model1: new AbortController(),
      model2: new AbortController()
    }

    try {
      const response = await fetch('/api/compare-models', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt,
          model1Id: model1.modelId,
          model2Id: model2.modelId,
          model1Name: model1.name,
          model2Name: model2.name
        }),
        signal: abortControllerRef.current.model1?.signal
      })

      if (!response.ok) {
        throw new Error('Failed to start comparison')
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      if (!reader) {
        throw new Error('No response body')
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value)
        const lines = chunk.split('\n').filter(line => line.trim())

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const handleNestedBranch1 = () => {
              try {
              const data = JSON.parse(line.slice(6))

              // Handle model1 data
              if ('model1' in data) {
                setResponses(prev => ({ ...prev, model1: prev.model1 + data.model1 }))
              } else if ('model1Error' in data) {
                setResponses(prev => ({ ...prev, error1: data.model1Error }))
                setIsLoading(prev => ({ ...prev, model1: false }))
              } else if ('model1Finished' in data) {
                setIsLoading(prev => ({ ...prev, model1: false }))
              }

              // Handle model2 data
              if ('model2' in data) {
                setResponses(prev => ({ ...prev, model2: prev.model2 + data.model2 }))
              } else if ('model2Error' in data) {
                setResponses(prev => ({ ...prev, error2: data.model2Error }))
                setIsLoading(prev => ({ ...prev, model2: false }))
              } else if ('model2Finished' in data) {
                setIsLoading(prev => ({ ...prev, model2: false }))
              }

              // Handle overall completion
              if ('done' in data) {
                setIsLoading({ model1: false, model2: false })
              }
            } catch {
              // Failed to parse SSE data - silently handle
            }
            }
            handleNestedBranch1()
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') {
        setResponses(prev => ({
          ...prev,
          error1: prev.error1 || 'Failed to complete comparison',
          error2: prev.error2 || 'Failed to complete comparison'
        }))
      }
    } finally {
      setIsLoading({ model1: false, model2: false })
    }
  }, [])

  const stopStream = useCallback((model: 'model1' | 'model2') => {
    if (abortControllerRef.current[model]) {
      abortControllerRef.current[model]?.abort()
      setIsLoading(prev => ({ ...prev, [model]: false }))
    }
  }, [])

  const clearResponses = useCallback(() => {
    setResponses({ model1: "", model2: "" })
    setIsLoading({ model1: false, model2: false })
    abortControllerRef.current = {}
  }, [])

  return {
    responses,
    isLoading,
    streamComparison,
    stopStream,
    clearResponses
  }
}