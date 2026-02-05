"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useToast } from "@/components/ui/use-toast"
import type { SelectAiModel } from "@/types"
import { z } from "zod"
import { createLogger } from "@/lib/client-logger"

const log = createLogger({ module: 'use-models' })

// Validation schema for localStorage model data
// This is a partial schema - we only validate the fields we actually use
const StoredModelSchema = z.object({
  id: z.number(),
  modelId: z.string(),
  name: z.string(),
  provider: z.string(),
  active: z.boolean(),
  nexusEnabled: z.boolean(),
  capabilities: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  description: z.string().nullable().optional(),
  maxTokens: z.number().nullable().optional(),
}).passthrough() // Allow additional fields from SelectAiModel type

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
  
  // Load persisted model on mount with validation
  useEffect(() => {
    const savedData = localStorage.getItem(`${storageKey}Data`)
    if (savedData) {
      try {
        const parsed = JSON.parse(savedData)
        const validation = StoredModelSchema.safeParse(parsed)

        if (validation.success) {
          setSelectedModelState(validation.data as SelectAiModel)
        } else {
          log.warn('Invalid model data in localStorage, cleaning up', {
            storageKey,
            errorCount: validation.error.issues.length
          })
          // Clean up invalid data
          localStorage.removeItem(`${storageKey}Data`)
          localStorage.removeItem(`${storageKey}Id`)
        }
      } catch (error) {
        log.warn('Failed to parse localStorage model data', {
          storageKey,
          error: error instanceof Error ? error.message : String(error)
        })
        // Invalid JSON, clean up
        localStorage.removeItem(`${storageKey}Data`)
        localStorage.removeItem(`${storageKey}Id`)
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
  // Tracks the last model ID this effect validated to prevent redundant runs.
  // This allows selectedModel in the dependency array (no stale closure)
  // while preventing infinite loops from setSelectedModel triggering re-runs.
  const lastValidatedModelId = useRef<string | null | undefined>(undefined)

  // Auto-select a valid model if none selected or if persisted model is no longer available
  useEffect(() => {
    if (models.length === 0 || isLoading) return

    const currentModelId = selectedModel?.modelId ?? null

    // Skip if we've already validated this model ID against this models list
    if (currentModelId === lastValidatedModelId.current) return

    const isStale = currentModelId && !models.some(m => m.modelId === currentModelId)

    if (!currentModelId || isStale) {
      if (isStale && selectedModel) {
        log.info('Stale model detected, auto-selecting new model', {
          staleModelId: selectedModel.modelId,
          staleName: selectedModel.name,
          availableCount: models.length
        })
      }

      // Find a model that matches required capabilities
      let candidateModel: SelectAiModel | null = null

      if (requiredCapabilities && requiredCapabilities.length > 0) {
        candidateModel = models.find(model => {
          try {
            const capabilities = typeof model.capabilities === 'string'
              ? JSON.parse(model.capabilities)
              : model.capabilities

            if (!Array.isArray(capabilities)) {
              log.warn('Model has invalid capabilities format', {
                modelId: model.modelId,
                capabilitiesType: typeof capabilities
              })
              return false
            }

            return requiredCapabilities.every(cap => capabilities.includes(cap))
          } catch (error) {
            log.warn('Failed to parse model capabilities', {
              modelId: model.modelId,
              error: error instanceof Error ? error.message : String(error)
            })
            return false
          }
        }) ?? null

        // If no model matches required capabilities, don't fall back to models[0]
        // Instead, leave it null to prompt user selection
        if (!candidateModel) {
          log.warn('No models match required capabilities', {
            requiredCapabilities,
            availableModels: models.map(m => m.modelId)
          })
        }
      } else {
        // No capability requirements, default to first model
        candidateModel = models[0]
      }

      if (candidateModel) {
        setSelectedModel(candidateModel)
        lastValidatedModelId.current = candidateModel.modelId
        log.info('Auto-selected model', {
          modelId: candidateModel.modelId,
          name: candidateModel.name
        })
      }
    } else {
      // Current model is valid — record it so we don't re-validate
      lastValidatedModelId.current = currentModelId
    }
  }, [models, isLoading, requiredCapabilities, setSelectedModel, selectedModel])

  return {
    models,
    selectedModel,
    setSelectedModel,
    isLoading,
    error,
    refetch
  }
}