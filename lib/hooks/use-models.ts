"use client"

import { useState, useEffect, useCallback } from "react"
import { useToast } from "@/components/ui/use-toast"
import type { SelectAiModel } from "@/types"

/**
 * Shared hook for fetching and managing AI models
 * Used by both chat and model compare features
 */
export function useModels() {
  const [models, setModels] = useState<SelectAiModel[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()

  const fetchModels = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch("/api/models", {
        cache: 'no-store'
      })
      
      if (!response.ok) {
        throw new Error("Failed to fetch models")
      }
      
      const result = await response.json()
      const modelsData = result.data || result
      
      if (!Array.isArray(modelsData)) {
        throw new TypeError("Invalid models data")
      }
      
      setModels(modelsData)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load models"
      setError(message)
      toast({
        title: "Error",
        description: message,
        variant: "destructive"
      })
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  return {
    models,
    isLoading,
    error,
    refetch: fetchModels
  }
}

/**
 * Hook for persisting model selection to localStorage
 * Supports both single model (chat) and dual model (compare) scenarios
 */
export function useModelPersistence(storageKey: string) {
  const [selectedModel, setSelectedModelState] = useState<SelectAiModel | null>(null)
  
  // Load persisted model on mount
  useEffect(() => {
    const savedData = localStorage.getItem(`${storageKey}Data`)
    if (savedData) {
      try {
        const model = JSON.parse(savedData)
        setSelectedModelState(model)
      } catch {
        // Invalid stored data, ignore
      }
    }
  }, [storageKey])
  
  // Wrapper to persist model selection
  const setSelectedModel = useCallback((model: SelectAiModel | null) => {
    setSelectedModelState(model)
    if (model) {
      localStorage.setItem(`${storageKey}Id`, model.modelId)
      localStorage.setItem(`${storageKey}Data`, JSON.stringify(model))
    } else {
      localStorage.removeItem(`${storageKey}Id`)
      localStorage.removeItem(`${storageKey}Data`)
    }
  }, [storageKey])
  
  return [selectedModel, setSelectedModel] as const
}

/**
 * Combined hook for models with persistence
 * Convenience wrapper that combines fetching and persistence
 */
export function useModelsWithPersistence(storageKey: string, requiredCapabilities?: string[]) {
  const { models, isLoading, error, refetch } = useModels()
  const [selectedModel, setSelectedModel] = useModelPersistence(storageKey)
  
  // Auto-select a valid model if none selected or if persisted model is no longer available
  useEffect(() => {
    if (models.length === 0 || isLoading) return

    // Check if persisted model still exists in available models
    const isStale = selectedModel && !models.some(m => m.modelId === selectedModel.modelId)

    if (!selectedModel || isStale) {
      let candidateModel = models[0]

      if (requiredCapabilities && requiredCapabilities.length > 0) {
        candidateModel = models.find(model => {
          try {
            const capabilities = typeof model.capabilities === 'string'
              ? JSON.parse(model.capabilities)
              : model.capabilities
            return Array.isArray(capabilities) &&
              requiredCapabilities.every(cap => capabilities.includes(cap))
          } catch {
            return false
          }
        }) || models[0]
      }

      setSelectedModel(candidateModel)
    }
  }, [models, selectedModel, isLoading, requiredCapabilities, setSelectedModel])
  
  return {
    models,
    selectedModel,
    setSelectedModel,
    isLoading,
    error,
    refetch
  }
}