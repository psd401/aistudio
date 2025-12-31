"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { useToast } from "@/components/ui/use-toast"
import { createLogger, generateRequestId } from "@/lib/logger"
import { Button } from "@/components/ui/button"
import { IconRefresh, IconPlus } from "@tabler/icons-react"
import { ModelReplacementDialog } from "@/components/features/model-replacement-dialog"

import { StatsCards, StatsCardsSkeleton, type ModelStats } from "./stats-cards"
import { ModelFilters, type ModelFiltersState } from "./model-filters"
import { ModelsDataTable, type ModelTableRow } from "./models-data-table"
import { ModelDetailModal, type ModelFormData } from "./model-detail-modal"

import type { SelectAiModel } from "@/types/db-types"
import type { MultiSelectOption } from "@/components/ui/multi-select"

interface ModelsPageClientProps {
  initialModels: SelectAiModel[]
}

// Fallback role options
const fallbackRoleOptions: MultiSelectOption[] = [
  { value: "administrator", label: "Administrator", description: "Full system access" },
  { value: "staff", label: "Staff", description: "Staff member access" },
  { value: "student", label: "Student", description: "Basic user access" },
]

export function ModelsPageClient({ initialModels }: ModelsPageClientProps) {
  const { toast } = useToast()

  // State
  const [models, setModels] = useState<SelectAiModel[]>(initialModels)
  const [loading, setLoading] = useState(false)
  const [roleOptions, setRoleOptions] = useState<MultiSelectOption[]>(fallbackRoleOptions)
  const [roleLoading, setRoleLoading] = useState(true)
  const [loadingToggles, setLoadingToggles] = useState<Set<number>>(new Set())

  // Filters
  const [filters, setFilters] = useState<ModelFiltersState>({
    search: "",
    status: "all",
    provider: "all",
    availability: "all",
  })

  // Modal state
  const [selectedModel, setSelectedModel] = useState<SelectAiModel | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [isNewModel, setIsNewModel] = useState(false)

  // Replacement dialog state
  const [replacementDialog, setReplacementDialog] = useState<{
    isOpen: boolean
    model: SelectAiModel | null
    referenceCounts: {
      chainPrompts: number
      conversations: number
      modelComparisons: number
    }
  }>({
    isOpen: false,
    model: null,
    referenceCounts: { chainPrompts: 0, conversations: 0, modelComparisons: 0 },
  })

  // Calculate stats from models
  const stats: ModelStats = useMemo(() => {
    const byProvider: Record<string, number> = {}
    let activeCount = 0
    let nexusCount = 0

    for (const model of models) {
      // Count by provider
      const provider = model.provider || "Unknown"
      byProvider[provider] = (byProvider[provider] || 0) + 1

      // Count active
      if (model.active) {
        activeCount++
      }

      // Count nexus enabled
      if (model.nexusEnabled) {
        nexusCount++
      }
    }

    return {
      totalModels: models.length,
      activeModels: activeCount,
      nexusEnabled: nexusCount,
      byProvider,
    }
  }, [models])

  // Filter models based on current filters
  const filteredModels = useMemo(() => {
    return models.filter((model) => {
      // Search filter
      if (filters.search) {
        const search = filters.search.toLowerCase()
        const matchesName = model.name.toLowerCase().includes(search)
        const matchesId = model.modelId.toLowerCase().includes(search)
        if (!matchesName && !matchesId) {
          return false
        }
      }

      // Status filter
      if (filters.status === "active" && !model.active) {
        return false
      }
      if (filters.status === "inactive" && model.active) {
        return false
      }

      // Provider filter
      if (filters.provider !== "all" && model.provider !== filters.provider) {
        return false
      }

      // Availability filter
      if (filters.availability === "nexus" && !model.nexusEnabled) {
        return false
      }
      if (filters.availability === "architect" && !model.architectEnabled) {
        return false
      }

      return true
    })
  }, [models, filters])

  // Transform models for table
  const tableModels: ModelTableRow[] = filteredModels.map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    modelId: model.modelId,
    description: model.description,
    active: model.active,
    nexusEnabled: model.nexusEnabled ?? true,
    architectEnabled: model.architectEnabled ?? true,
  }))

  // Fetch roles on mount
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const fetchRoles = async () => {
      try {
        setRoleLoading(true)
        const response = await fetch("/api/admin/roles", {
          signal: controller.signal,
        })

        if (!response.ok || cancelled) {
          setRoleOptions(fallbackRoleOptions)
          return
        }

        const data = await response.json()

        if (!data.isSuccess || !Array.isArray(data.data)) {
          setRoleOptions(fallbackRoleOptions)
          return
        }

        const options: MultiSelectOption[] = data.data
          .filter(
            (role: unknown): role is { id: string; name: string; description?: string } =>
              role != null &&
              typeof role === "object" &&
              "id" in role &&
              "name" in role &&
              typeof (role as { name: unknown }).name === "string"
          )
          .map((role: { name: string; description?: string }) => ({
            value: role.name,
            label: role.name,
            description: role.description || "User role",
          }))

        if (!cancelled) {
          setRoleOptions(options.length > 0 ? options : fallbackRoleOptions)
        }
      } catch (error) {
        const log = createLogger({ requestId: generateRequestId(), action: "fetchRoles" })
        log.error("Failed to fetch roles", {
          error: error instanceof Error ? error.message : String(error),
        })
        if (!cancelled) {
          setRoleOptions(fallbackRoleOptions)
        }
      } finally {
        if (!cancelled) {
          setRoleLoading(false)
        }
      }
    }

    fetchRoles()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  // Refresh data
  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/admin/models")
      if (!response.ok) {
        throw new Error("Failed to load models")
      }
      const data = await response.json()

      // Runtime validation for API response
      if (data.isSuccess && Array.isArray(data.data)) {
        const validModels = data.data.filter(
          (
            model: unknown
          ): model is SelectAiModel =>
            model != null &&
            typeof model === "object" &&
            "id" in model &&
            "name" in model &&
            "provider" in model &&
            "modelId" in model &&
            typeof (model as { id: unknown }).id === "number" &&
            typeof (model as { name: unknown }).name === "string" &&
            typeof (model as { provider: unknown }).provider === "string" &&
            typeof (model as { modelId: unknown }).modelId === "string"
        )

        setModels(validModels)
      }
    } catch (error) {
      const log = createLogger({ requestId: generateRequestId(), action: "loadModels" })
      log.error("Failed to load models", {
        error: error instanceof Error ? error.message : String(error),
      })
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to load models",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  // Handle filter changes
  const handleFiltersChange = useCallback((newFilters: ModelFiltersState) => {
    setFilters(newFilters)
  }, [])

  // Handle view/edit model
  const handleViewModel = useCallback((model: ModelTableRow) => {
    const fullModel = models.find((m) => m.id === model.id)
    if (fullModel) {
      setSelectedModel(fullModel)
      setIsNewModel(false)
      setModalOpen(true)
    }
  }, [models])

  // Handle add new model
  const handleAddModel = useCallback(() => {
    setSelectedModel(null)
    setIsNewModel(true)
    setModalOpen(true)
  }, [])

  // Handle toggle active
  const handleToggleActive = useCallback(
    async (modelId: number, active: boolean) => {
      // Add to loading state
      setLoadingToggles((prev) => new Set(prev).add(modelId))

      // Optimistic update
      setModels((prev) => prev.map((m) => (m.id === modelId ? { ...m, active } : m)))

      try {
        const response = await fetch("/api/admin/models", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: modelId, active }),
        })

        if (!response.ok) {
          throw new Error("Failed to update model")
        }

        toast({
          description: `Model ${active ? "activated" : "deactivated"} successfully`,
        })
      } catch (error) {
        const log = createLogger({ requestId: generateRequestId(), action: "toggleActive" })
        log.error("Failed to toggle active status", {
          modelId,
          active,
          error: error instanceof Error ? error.message : String(error),
        })

        // Revert optimistic update
        setModels((prev) => prev.map((m) => (m.id === modelId ? { ...m, active: !active } : m)))

        toast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to update model",
          variant: "destructive",
        })
      } finally {
        // Remove from loading state
        setLoadingToggles((prev) => {
          const next = new Set(prev)
          next.delete(modelId)
          return next
        })
      }
    },
    [toast]
  )

  // Handle toggle nexus
  const handleToggleNexus = useCallback(
    async (modelId: number, enabled: boolean) => {
      // Add to loading state
      setLoadingToggles((prev) => new Set(prev).add(modelId))

      // Optimistic update
      setModels((prev) => prev.map((m) => (m.id === modelId ? { ...m, nexusEnabled: enabled } : m)))

      try {
        const response = await fetch("/api/admin/models", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: modelId, nexusEnabled: enabled }),
        })

        if (!response.ok) {
          throw new Error("Failed to update model")
        }

        toast({
          description: `Nexus ${enabled ? "enabled" : "disabled"} successfully`,
        })
      } catch (error) {
        const log = createLogger({ requestId: generateRequestId(), action: "toggleNexus" })
        log.error("Failed to toggle Nexus availability", {
          modelId,
          enabled,
          error: error instanceof Error ? error.message : String(error),
        })

        // Revert optimistic update
        setModels((prev) =>
          prev.map((m) => (m.id === modelId ? { ...m, nexusEnabled: !enabled } : m))
        )

        toast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to update model",
          variant: "destructive",
        })
      } finally {
        // Remove from loading state
        setLoadingToggles((prev) => {
          const next = new Set(prev)
          next.delete(modelId)
          return next
        })
      }
    },
    [toast]
  )

  // Handle toggle architect
  const handleToggleArchitect = useCallback(
    async (modelId: number, enabled: boolean) => {
      // Add to loading state
      setLoadingToggles((prev) => new Set(prev).add(modelId))

      // Optimistic update
      setModels((prev) =>
        prev.map((m) => (m.id === modelId ? { ...m, architectEnabled: enabled } : m))
      )

      try {
        const response = await fetch("/api/admin/models", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: modelId, architectEnabled: enabled }),
        })

        if (!response.ok) {
          throw new Error("Failed to update model")
        }

        toast({
          description: `Architect ${enabled ? "enabled" : "disabled"} successfully`,
        })
      } catch (error) {
        const log = createLogger({ requestId: generateRequestId(), action: "toggleArchitect" })
        log.error("Failed to toggle Architect availability", {
          modelId,
          enabled,
          error: error instanceof Error ? error.message : String(error),
        })

        // Revert optimistic update
        setModels((prev) =>
          prev.map((m) => (m.id === modelId ? { ...m, architectEnabled: !enabled } : m))
        )

        toast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to update model",
          variant: "destructive",
        })
      } finally {
        // Remove from loading state
        setLoadingToggles((prev) => {
          const next = new Set(prev)
          next.delete(modelId)
          return next
        })
      }
    },
    [toast]
  )

  // Handle delete model
  const handleDeleteModel = useCallback(
    async (model: ModelTableRow) => {
      try {
        // Check for references first
        const referenceResponse = await fetch(`/api/admin/models/${model.id}/references`)

        if (!referenceResponse.ok) {
          throw new Error("Failed to check model references")
        }

        const referenceData = await referenceResponse.json()

        if (referenceData.data?.hasReferences) {
          // Model has references, show replacement dialog
          const fullModel = models.find((m) => m.id === model.id)
          if (fullModel) {
            setReplacementDialog({
              isOpen: true,
              model: fullModel,
              referenceCounts: referenceData.data.counts,
            })
          }
        } else {
          // No references, proceed with direct deletion
          const response = await fetch(`/api/admin/models?id=${model.id}`, {
            method: "DELETE",
          })

          if (!response.ok) {
            throw new Error("Failed to delete model")
          }

          setModels((prev) => prev.filter((m) => m.id !== model.id))
          toast({
            title: "Success",
            description: "Model deleted successfully",
          })
        }
      } catch (error) {
        const log = createLogger({ requestId: generateRequestId(), action: "deleteModel" })
        log.error("Failed to delete model", {
          modelId: model.id,
          modelName: model.name,
          error: error instanceof Error ? error.message : String(error),
        })
        toast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to delete model",
          variant: "destructive",
        })
      }
    },
    [models, toast]
  )

  // Handle model replacement
  const handleModelReplacement = useCallback(
    async (replacementModelId: number) => {
      if (!replacementDialog.model) return

      try {
        const response = await fetch(
          `/api/admin/models/${replacementDialog.model.id}/replace`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ replacementModelId }),
          }
        )

        if (!response.ok) {
          const errorData = await response.json()
          throw new Error(errorData.message || "Failed to replace model")
        }

        const result = await response.json()

        // Remove the deleted model
        setModels((prev) => prev.filter((m) => m.id !== replacementDialog.model?.id))

        // Close dialog
        setReplacementDialog({
          isOpen: false,
          model: null,
          referenceCounts: { chainPrompts: 0, conversations: 0, modelComparisons: 0 },
        })

        toast({
          title: "Success",
          description: result.message || "Model replaced and deleted successfully",
        })
      } catch (error) {
        const log = createLogger({ requestId: generateRequestId(), action: "replaceModel" })
        log.error("Failed to replace model", {
          originalModelId: replacementDialog.model?.id,
          replacementModelId,
          error: error instanceof Error ? error.message : String(error),
        })
        toast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to replace model",
          variant: "destructive",
        })
      }
    },
    [replacementDialog.model, toast]
  )

  // Handle save model (add or update)
  const handleSaveModel = useCallback(
    async (data: ModelFormData) => {
      try {
        // Sync capabilities to nexusCapabilities for runtime compatibility
        const syncedNexusCapabilities = { ...data.nexusCapabilities }

        // Map capability strings to nexusCapabilities boolean flags
        const capabilityMapping: Record<string, string> = {
          web_search: "webSearch",
          code_interpreter: "codeInterpreter",
          code_execution: "codeExecution",
          canvas: "canvas",
          artifacts: "artifacts",
          thinking: "thinking",
          reasoning: "reasoning",
          computer_use: "computerUse",
        }

        // Update nexusCapabilities based on selected capabilities
        Object.entries(capabilityMapping).forEach(([capValue, nexusKey]) => {
          syncedNexusCapabilities[nexusKey] = data.capabilitiesList.includes(capValue)
        })

        // Prepare data for API
        const apiData = {
          ...data,
          capabilities:
            data.capabilitiesList.length > 0
              ? JSON.stringify(data.capabilitiesList)
              : null,
          allowedRoles: data.allowedRoles.length > 0 ? data.allowedRoles : null,
          nexusCapabilities:
            Object.keys(syncedNexusCapabilities).length > 0 ? syncedNexusCapabilities : null,
          providerMetadata:
            Object.keys(data.providerMetadata).length > 0 ? data.providerMetadata : null,
        }

        if (isNewModel) {
          // Create new model
          const response = await fetch("/api/admin/models", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(apiData),
          })

          if (!response.ok) {
            const errorText = await response.text()
            throw new Error(errorText || "Failed to add model")
          }

          const result = await response.json()
          setModels((prev) => [...prev, result.data])

          toast({
            title: "Success",
            description: "Model added successfully",
          })
        } else if (data.id) {
          // Update existing model
          const response = await fetch("/api/admin/models", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: data.id, ...apiData }),
          })

          if (!response.ok) {
            const errorText = await response.text()
            throw new Error(errorText || "Failed to update model")
          }

          const result = await response.json()
          setModels((prev) =>
            prev.map((m) => (m.id === data.id ? result.data : m))
          )

          toast({
            title: "Success",
            description: "Model updated successfully",
          })
        }
      } catch (error) {
        const log = createLogger({ requestId: generateRequestId(), action: "saveModel" })
        log.error("Failed to save model", {
          modelId: data.id,
          modelName: data.name,
          isNewModel,
          error: error instanceof Error ? error.message : String(error),
        })
        toast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to save model",
          variant: "destructive",
        })
        throw error
      }
    },
    [isNewModel, toast]
  )

  // Handle delete from modal
  const handleDeleteFromModal = useCallback(
    (model: SelectAiModel) => {
      setModalOpen(false)
      handleDeleteModel({
        id: model.id,
        name: model.name,
        provider: model.provider,
        modelId: model.modelId,
        description: model.description,
        active: model.active,
        nexusEnabled: model.nexusEnabled ?? true,
        architectEnabled: model.architectEnabled ?? true,
      })
    },
    [handleDeleteModel]
  )

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">AI Models Management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage AI models, providers, and availability settings
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
            <IconRefresh className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button size="sm" onClick={handleAddModel}>
            <IconPlus className="h-4 w-4 mr-2" />
            Add Model
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      {loading ? (
        <StatsCardsSkeleton />
      ) : (
        <StatsCards stats={stats} />
      )}

      {/* Filters */}
      <ModelFilters onFiltersChange={handleFiltersChange} initialFilters={filters} />

      {/* Data Table */}
      <ModelsDataTable
        models={tableModels}
        onViewModel={handleViewModel}
        onToggleActive={handleToggleActive}
        onToggleNexus={handleToggleNexus}
        onToggleArchitect={handleToggleArchitect}
        onDeleteModel={handleDeleteModel}
        loading={loading}
        loadingToggles={loadingToggles}
      />

      {/* Model Detail Modal */}
      <ModelDetailModal
        model={selectedModel}
        isNew={isNewModel}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSave={handleSaveModel}
        onDelete={handleDeleteFromModal}
        roleOptions={roleOptions}
        roleLoading={roleLoading}
      />

      {/* Replacement Dialog */}
      {replacementDialog.model && (
        <ModelReplacementDialog
          isOpen={replacementDialog.isOpen}
          onClose={() =>
            setReplacementDialog({
              isOpen: false,
              model: null,
              referenceCounts: { chainPrompts: 0, conversations: 0, modelComparisons: 0 },
            })
          }
          modelToDelete={replacementDialog.model}
          availableModels={models}
          referenceCounts={replacementDialog.referenceCounts}
          onConfirm={handleModelReplacement}
        />
      )}
    </div>
  )
}
