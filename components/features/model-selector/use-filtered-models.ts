"use client"

import { useMemo } from "react"
import type { 
  UseFilteredModelsOptions, 
  UseFilteredModelsResult, 
  FilteredModel 
} from "./model-selector-types"

/**
 * Safely parse a JSON array from various input types
 * @param value - The value to parse (can be string, array, or unknown)
 * @param fallback - Default value if parsing fails
 * @returns Validated array of strings
 */
function safeParseJsonArray(value: unknown, fallback: string[] = []): string[] {
  if (!value) return fallback
  
  // Already an array
  if (Array.isArray(value)) {
    return value.filter(item => typeof item === 'string')
  }
  
  // String that needs parsing
  if (typeof value === 'string') {
    const trimmedValue = value.trim()
    
    // Empty string
    if (!trimmedValue) return fallback
    
    // Try parsing as JSON
    if (trimmedValue.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmedValue)
        if (Array.isArray(parsed)) {
          return parsed.filter(item => typeof item === 'string')
        }
      } catch {
        // Invalid JSON, continue to comma-separated fallback
      }
    }
    
    // Try as comma-separated values
    if (trimmedValue.includes(',')) {
      return trimmedValue
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
    }
    
    // Single value
    return [trimmedValue]
  }
  
  return fallback
}

export function useFilteredModels({
  models,
  requiredCapabilities = [],
  anyOfCapabilities = [],
  searchQuery = "",
  hideCapabilityMissing = false
}: UseFilteredModelsOptions): UseFilteredModelsResult {

  // NOTE (#1207): per-model ROLE access is enforced entirely server-side now —
  // /api/models filters the list through resource_access_grants before it ever
  // reaches the client, so a model the user cannot access is simply absent. The
  // old client-side role filter (model.allowedRoles vs the user's roles) was
  // advisory, fail-open, and duplicated that server gate; it was removed along
  // with the ai_models.allowed_roles column. Only CAPABILITY filtering (a UI
  // concern — which models can do image/vision/etc.) remains here.
  const result = useMemo(() => {
    let filteredModels: FilteredModel[] = models.map(model => {
      // Safely parse capabilities
      const modelCapabilities = safeParseJsonArray(model.capabilities, [])

      // Check required capabilities (AND logic — all must be present)
      const missingCapabilities = requiredCapabilities.filter(
        cap => !modelCapabilities.includes(cap)
      )
      const matchesRequiredCapabilities = missingCapabilities.length === 0

      // Check anyOf capabilities (OR logic — at least one must be present)
      const matchesAnyOfCapabilities =
        anyOfCapabilities.length === 0 ||
        anyOfCapabilities.some(cap => modelCapabilities.includes(cap))

      const matchesCapabilities = matchesRequiredCapabilities && matchesAnyOfCapabilities

      const isAccessible = matchesCapabilities

      // Combine AND-missing and anyOf-missing capabilities for accurate UI feedback
      const allMissingCapabilities = [
        ...missingCapabilities,
        ...(anyOfCapabilities.length > 0 && !matchesAnyOfCapabilities
          ? [`one of: ${anyOfCapabilities.join(', ')}`]
          : [])
      ]

      let accessDeniedReason: string | undefined
      if (!matchesCapabilities) {
        if (missingCapabilities.length === 0 && anyOfCapabilities.length > 0 && !matchesAnyOfCapabilities) {
          // Only the OR-capability check failed — use a cleaner message
          accessDeniedReason = `Requires at least one of: ${anyOfCapabilities.join(', ')}`
        } else if (allMissingCapabilities.length > 0) {
          accessDeniedReason = `Missing capabilities: ${allMissingCapabilities.join(', ')}`
        } else {
          accessDeniedReason = `Missing required capabilities`
        }
      }

      return {
        ...model,
        isAccessible,
        accessDeniedReason,
        matchesCapabilities,
        missingCapabilities: allMissingCapabilities.length > 0 ? allMissingCapabilities : undefined
      } as FilteredModel
    })

    // Filter out models missing capabilities if hideCapabilityMissing is true
    if (hideCapabilityMissing) {
      filteredModels = filteredModels.filter(model => model.matchesCapabilities)
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      filteredModels = filteredModels.filter(model => 
        model.name.toLowerCase().includes(query) ||
        model.modelId.toLowerCase().includes(query) ||
        (model.provider && model.provider.toLowerCase().includes(query)) ||
        (model.description && model.description.toLowerCase().includes(query))
      )
    }

    // Group models by provider
    const groupedModels: Record<string, FilteredModel[]> = {}
    for (const model of filteredModels) {
      const provider = model.provider || 'Other'
      if (!groupedModels[provider]) {
        groupedModels[provider] = []
      }
      groupedModels[provider].push(model)
    }

    // Sort models within each group
    for (const provider of Object.keys(groupedModels)) {
      groupedModels[provider].sort((a, b) => {
        // Accessible models first
        if (a.isAccessible !== b.isAccessible) {
          return a.isAccessible ? -1 : 1
        }
        // Then by name
        return a.name.localeCompare(b.name)
      })
    }

    const totalCount = filteredModels.length
    const accessibleCount = filteredModels.filter(m => m.isAccessible).length

    return {
      filteredModels,
      groupedModels,
      totalCount,
      accessibleCount
    }
  }, [models, requiredCapabilities, anyOfCapabilities, searchQuery, hideCapabilityMissing])

  return result
}