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
  allowedRoles = [],
  userRoles = [],
  searchQuery = "",
  hideRoleRestricted = false,
  hideCapabilityMissing = false
}: UseFilteredModelsOptions): UseFilteredModelsResult {
  
  const result = useMemo(() => {
    let filteredModels: FilteredModel[] = models.map(model => {
      // Safely parse capabilities
      const modelCapabilities = safeParseJsonArray(model.capabilities, [])

      // Check capability requirements
      const missingCapabilities = requiredCapabilities.filter(
        cap => !modelCapabilities.includes(cap)
      )
      const matchesCapabilities = missingCapabilities.length === 0

      // Safely parse allowed roles for the model
      const modelAllowedRoles = safeParseJsonArray(model.allowedRoles, [])

      // Check role-based access
      // If modelAllowedRoles is empty or null, model is accessible to all
      const hasRoleAccess = modelAllowedRoles.length === 0 || 
        modelAllowedRoles.some(role => userRoles.includes(role))
      
      // Check if user's allowed roles match (for component-level filtering)
      const meetsAllowedRoles = allowedRoles.length === 0 ||
        allowedRoles.some(role => userRoles.includes(role))

      const isAccessible = matchesCapabilities && hasRoleAccess && meetsAllowedRoles

      let accessDeniedReason: string | undefined
      if (!matchesCapabilities) {
        accessDeniedReason = `Missing capabilities: ${missingCapabilities.join(', ')}`
      } else if (!hasRoleAccess) {
        accessDeniedReason = `Requires role: ${modelAllowedRoles.join(' or ')}`
      } else if (!meetsAllowedRoles) {
        accessDeniedReason = `Your role doesn't have access to this feature`
      }

      return {
        ...model,
        isAccessible,
        accessDeniedReason,
        matchesCapabilities,
        hasRoleAccess,
        missingCapabilities: missingCapabilities.length > 0 ? missingCapabilities : undefined
      } as FilteredModel
    })

    // Filter out role-restricted models if hideRoleRestricted is true
    if (hideRoleRestricted) {
      filteredModels = filteredModels.filter(model => model.hasRoleAccess)
    }
    
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
  }, [models, requiredCapabilities, allowedRoles, userRoles, searchQuery, hideRoleRestricted, hideCapabilityMissing])

  return result
}