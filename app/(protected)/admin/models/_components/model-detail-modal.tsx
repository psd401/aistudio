"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { createLogger, generateRequestId } from "@/lib/logger"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { MultiSelect, type MultiSelectOption } from "@/components/ui/multi-select"
import { Separator } from "@/components/ui/separator"
import { IconChevronRight, IconCopy, IconTrash, IconLoader2 } from "@tabler/icons-react"
import { useToast } from "@/components/ui/use-toast"
import { cn } from "@/lib/utils"
import { ProviderBadge, PROVIDER_OPTIONS } from "./provider-badge"
import type { SelectAiModel } from "@/types/db-types"
import type { NexusCapabilities, ProviderMetadata } from "@/lib/db/types/jsonb"

// Form data type
export interface ModelFormData {
  id?: number
  name: string
  provider: string
  modelId: string
  description: string
  capabilities: string
  capabilitiesList: string[]
  maxTokens: number
  active: boolean
  chatEnabled: boolean
  nexusEnabled: boolean
  architectEnabled: boolean
  allowedRoles: string[]
  // Pricing
  inputCostPer1kTokens: string | null
  outputCostPer1kTokens: string | null
  cachedInputCostPer1kTokens: string | null
  // Performance (not displayed but preserved)
  averageLatencyMs: number | null
  maxConcurrency: number | null
  supportsBatching: boolean
  // Advanced
  nexusCapabilities: NexusCapabilities
  providerMetadata: ProviderMetadata
}

// Default capabilities for new models
const DEFAULT_NEXUS_CAPABILITIES: NexusCapabilities = {
  canvas: false,
  thinking: false,
  artifacts: false,
  grounding: false,
  reasoning: false,
  webSearch: false,
  computerUse: false,
  responsesAPI: false,
  codeExecution: false,
  promptCaching: false,
  contextCaching: false,
  workspaceTools: false,
  codeInterpreter: false,
}

// Empty form state
const emptyFormData: ModelFormData = {
  name: "",
  provider: "",
  modelId: "",
  description: "",
  capabilities: "",
  capabilitiesList: [],
  maxTokens: 4096,
  active: true,
  chatEnabled: false,
  nexusEnabled: true,
  architectEnabled: true,
  allowedRoles: [],
  inputCostPer1kTokens: null,
  outputCostPer1kTokens: null,
  cachedInputCostPer1kTokens: null,
  averageLatencyMs: null,
  maxConcurrency: null,
  supportsBatching: false,
  nexusCapabilities: { ...DEFAULT_NEXUS_CAPABILITIES },
  providerMetadata: {},
}

// Capability options for multi-select
const capabilityOptions: MultiSelectOption[] = [
  { value: "chat", label: "Chat", description: "General conversation" },
  { value: "code_interpreter", label: "Code Interpreter", description: "Execute code" },
  { value: "web_search", label: "Web Search", description: "Search the internet" },
  { value: "image_generation", label: "Image Generation", description: "Create images" },
  { value: "image_analysis", label: "Image Analysis", description: "Analyze images" },
  { value: "file_analysis", label: "File Analysis", description: "Process documents" },
  { value: "function_calling", label: "Function Calling", description: "Use tools/functions" },
  { value: "json_mode", label: "JSON Mode", description: "Structured JSON output" },
]

interface ModelDetailModalProps {
  model: SelectAiModel | null
  isNew?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (data: ModelFormData) => Promise<void>
  onDelete?: (model: SelectAiModel) => void
  roleOptions: MultiSelectOption[]
  roleLoading?: boolean
}

export function ModelDetailModal({
  model,
  isNew = false,
  open,
  onOpenChange,
  onSave,
  onDelete,
  roleOptions,
  roleLoading = false,
}: ModelDetailModalProps) {
  const { toast } = useToast()
  const [formData, setFormData] = useState<ModelFormData>(emptyFormData)
  const [saving, setSaving] = useState(false)

  // Focus management refs
  const firstInputRef = useRef<HTMLInputElement>(null)
  const triggerElementRef = useRef<HTMLElement | null>(null)
  const [costOpen, setCostOpen] = useState(false)

  // Cost validation errors
  const [costErrors, setCostErrors] = useState<{
    inputCostPer1kTokens?: string
    outputCostPer1kTokens?: string
    cachedInputCostPer1kTokens?: string
  }>({})

  // Initialize form data when model changes
  useEffect(() => {
    if (model) {
      // Parse capabilities
      let capabilitiesList: string[] = []
      if (model.capabilities) {
        try {
          const parsed =
            typeof model.capabilities === "string"
              ? JSON.parse(model.capabilities)
              : model.capabilities
          if (Array.isArray(parsed)) {
            capabilitiesList = parsed
          }
        } catch (error) {
          const log = createLogger({ requestId: generateRequestId(), action: "parseCapabilities" })
          log.error("Failed to parse capabilities JSON", {
            modelId: model.id,
            error: error instanceof Error ? error.message : String(error),
          })
          if (typeof model.capabilities === "string" && model.capabilities.trim()) {
            capabilitiesList = [model.capabilities]
          }
        }
      }

      // Parse allowed roles
      let allowedRoles: string[] = []
      if (model.allowedRoles && Array.isArray(model.allowedRoles)) {
        allowedRoles = model.allowedRoles
      }

      setFormData({
        id: model.id,
        name: model.name,
        provider: model.provider || "",
        modelId: model.modelId,
        description: model.description || "",
        capabilities: model.capabilities || "",
        capabilitiesList,
        maxTokens: model.maxTokens || 4096,
        active: model.active,
        chatEnabled: model.chatEnabled || false,
        nexusEnabled: model.nexusEnabled ?? true,
        architectEnabled: model.architectEnabled ?? true,
        allowedRoles,
        inputCostPer1kTokens: model.inputCostPer1kTokens || null,
        outputCostPer1kTokens: model.outputCostPer1kTokens || null,
        cachedInputCostPer1kTokens: model.cachedInputCostPer1kTokens || null,
        averageLatencyMs: model.averageLatencyMs || null,
        maxConcurrency: model.maxConcurrency || null,
        supportsBatching: model.supportsBatching || false,
        nexusCapabilities: model.nexusCapabilities
          ? typeof model.nexusCapabilities === "string"
            ? JSON.parse(model.nexusCapabilities)
            : model.nexusCapabilities
          : { ...DEFAULT_NEXUS_CAPABILITIES },
        providerMetadata: model.providerMetadata
          ? typeof model.providerMetadata === "string"
            ? JSON.parse(model.providerMetadata)
            : model.providerMetadata
          : {},
      })
    } else if (isNew) {
      setFormData(emptyFormData)
    }
  }, [model, isNew, open])

  // Focus management - capture trigger and focus first input on open
  useEffect(() => {
    if (open) {
      // Capture the element that triggered the dialog
      triggerElementRef.current = document.activeElement as HTMLElement

      // Focus first input after dialog animation (150ms)
      const timer = setTimeout(() => {
        firstInputRef.current?.focus()
      }, 150)

      return () => clearTimeout(timer)
    } else {
      // Return focus to trigger element when closed
      triggerElementRef.current?.focus()
    }
  }, [open])

  // Field handlers
  const updateField = useCallback(
    <K extends keyof ModelFormData>(field: K, value: ModelFormData[K]) => {
      setFormData((prev) => ({ ...prev, [field]: value }))
    },
    []
  )

  // Cost field handler with validation
  const handleCostChange = useCallback(
    (field: "inputCostPer1kTokens" | "outputCostPer1kTokens" | "cachedInputCostPer1kTokens") =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value

        // Allow empty values
        if (!value) {
          updateField(field, null)
          setCostErrors((prev) => ({ ...prev, [field]: undefined }))
          return
        }

        // Only allow positive numbers with optional decimal
        const numericPattern = /^\d*\.?\d*$/
        if (!numericPattern.test(value)) {
          setCostErrors((prev) => ({ ...prev, [field]: "Must be a valid number" }))
          return
        }

        // Validate range
        const parsed = Number.parseFloat(value)
        if (Number.isNaN(parsed)) {
          setCostErrors((prev) => ({ ...prev, [field]: "Must be a valid number" }))
          return
        }

        if (parsed < 0) {
          setCostErrors((prev) => ({ ...prev, [field]: "Must be 0 or greater" }))
          return
        }

        if (parsed > 100) {
          setCostErrors((prev) => ({ ...prev, [field]: "Must be 100 or less" }))
          return
        }

        // Valid value
        updateField(field, value)
        setCostErrors((prev) => ({ ...prev, [field]: undefined }))
      },
    [updateField]
  )

  // Copy ID to clipboard
  const copyId = useCallback(() => {
    if (model?.id) {
      navigator.clipboard.writeText(model.id.toString())
      toast({ description: "ID copied to clipboard" })
    }
  }, [model?.id, toast])

  // Save handler
  const handleSave = useCallback(async () => {
    // Validation
    if (!formData.name.trim()) {
      toast({ title: "Error", description: "Name is required", variant: "destructive" })
      return
    }
    if (!formData.provider) {
      toast({ title: "Error", description: "Provider is required", variant: "destructive" })
      return
    }
    if (!formData.modelId.trim()) {
      toast({ title: "Error", description: "Model ID is required", variant: "destructive" })
      return
    }

    setSaving(true)
    try {
      await onSave(formData)
      onOpenChange(false)
    } catch (error) {
      const log = createLogger({ requestId: generateRequestId(), action: "saveModel" })
      log.error("Model save error in modal", {
        modelName: formData.name,
        error: error instanceof Error ? error.message : String(error),
      })
      // Error toast is shown in parent component
    } finally {
      setSaving(false)
    }
  }, [formData, onSave, onOpenChange, toast])

  const title = isNew ? "Add New Model" : `Edit ${model?.name || "Model"}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[95vw] max-h-[90vh] w-full h-full flex flex-col"
        style={{ maxWidth: '95vw', maxHeight: '90vh', width: '95vw' } as React.CSSProperties}
        data-wide-modal="true"
      >
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center gap-3">
            <DialogTitle className="text-xl">{title}</DialogTitle>
            {model && <ProviderBadge provider={formData.provider} />}
          </div>
          <DialogDescription className="sr-only">
            {isNew ? "Add a new AI model to the system" : "Edit AI model configuration"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 py-4">
            {/* Left Panel - Identity & Connection */}
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold mb-4">Identity & Connection</h3>
                <div className="space-y-4">
                  {/* Internal ID (read-only) */}
                  {model && (
                    <div className="space-y-2">
                      <Label>Internal ID</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          value={model.id.toString()}
                          disabled
                          className="bg-muted font-mono text-sm"
                        />
                        <Button variant="outline" size="icon" onClick={copyId}>
                          <IconCopy className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Display Name */}
                  <div className="space-y-2">
                    <Label htmlFor="name">Display Name *</Label>
                    <Input
                      ref={firstInputRef}
                      id="name"
                      value={formData.name}
                      onChange={(e) => updateField("name", e.target.value)}
                      placeholder="GPT-4 Turbo"
                    />
                  </div>

                  {/* Provider */}
                  <div className="space-y-2">
                    <Label>Provider *</Label>
                    <Select
                      value={formData.provider}
                      onValueChange={(v) => updateField("provider", v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a provider" />
                      </SelectTrigger>
                      <SelectContent>
                        {PROVIDER_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Model ID */}
                  <div className="space-y-2">
                    <Label htmlFor="modelId">Model ID *</Label>
                    <Input
                      id="modelId"
                      value={formData.modelId}
                      onChange={(e) => updateField("modelId", e.target.value)}
                      placeholder="gpt-4-turbo"
                      className="font-mono"
                    />
                    <p className="text-xs text-muted-foreground">
                      The API identifier used to call this model
                    </p>
                  </div>

                  {/* Description */}
                  <div className="space-y-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      id="description"
                      value={formData.description}
                      onChange={(e) => updateField("description", e.target.value)}
                      placeholder="Model description..."
                      rows={3}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Right Panel - Configuration */}
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold mb-4">Configuration</h3>
                <div className="space-y-4">
                  {/* Max Tokens */}
                  <div className="space-y-2">
                    <Label htmlFor="maxTokens">Max Tokens</Label>
                    <Input
                      id="maxTokens"
                      type="number"
                      value={formData.maxTokens}
                      onChange={(e) =>
                        updateField("maxTokens", Number.parseInt(e.target.value) || 4096)
                      }
                    />
                  </div>

                  {/* Capabilities */}
                  <div className="space-y-2">
                    <Label>Capabilities</Label>
                    <MultiSelect
                      options={capabilityOptions}
                      value={formData.capabilitiesList}
                      onChange={(v) => updateField("capabilitiesList", v)}
                      placeholder="Select capabilities"
                      allowCustom
                      customPlaceholder="Add custom capability..."
                      className="w-full"
                    />
                  </div>

                  {/* Allowed Roles */}
                  <div className="space-y-2">
                    <Label>
                      Allowed Roles
                      {roleLoading && (
                        <span className="ml-2 text-xs text-muted-foreground">(Loading...)</span>
                      )}
                    </Label>
                    <MultiSelect
                      options={roleOptions}
                      value={formData.allowedRoles}
                      onChange={(v) => updateField("allowedRoles", v)}
                      placeholder={roleLoading ? "Loading roles..." : "All roles (unrestricted)"}
                      disabled={roleLoading}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground">
                      Leave empty to allow access for all roles
                    </p>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Availability Section */}
              <div>
                <h3 className="text-lg font-semibold mb-4">Availability</h3>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="active">Active</Label>
                      <p className="text-xs text-muted-foreground">
                        Model is available for use
                      </p>
                    </div>
                    <Switch
                      id="active"
                      checked={formData.active}
                      onCheckedChange={(v) => updateField("active", v)}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="nexusEnabled">Nexus / Compare Enabled</Label>
                      <p className="text-xs text-muted-foreground">
                        Available in Nexus chat and Model Compare
                      </p>
                    </div>
                    <Switch
                      id="nexusEnabled"
                      checked={formData.nexusEnabled}
                      onCheckedChange={(v) => updateField("nexusEnabled", v)}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="architectEnabled">Assistant Architect Enabled</Label>
                      <p className="text-xs text-muted-foreground">
                        Available in Assistant Architect
                      </p>
                    </div>
                    <Switch
                      id="architectEnabled"
                      checked={formData.architectEnabled}
                      onCheckedChange={(v) => updateField("architectEnabled", v)}
                    />
                  </div>
                </div>
              </div>

              <Separator />

              {/* Cost Settings (Collapsible) */}
              <Collapsible open={costOpen} onOpenChange={setCostOpen}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" className="flex items-center gap-2 p-0 h-auto">
                    <IconChevronRight
                      className={cn(
                        "h-4 w-4 transition-transform",
                        costOpen && "rotate-90"
                      )}
                    />
                    <span className="text-lg font-semibold">Cost Settings</span>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-4 mt-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="inputCost">Input Cost per 1K tokens ($)</Label>
                      <Input
                        id="inputCost"
                        type="number"
                        step="0.000001"
                        value={formData.inputCostPer1kTokens || ""}
                        onChange={handleCostChange("inputCostPer1kTokens")}
                        placeholder="0.000000"
                        aria-invalid={!!costErrors.inputCostPer1kTokens}
                        aria-describedby={
                          costErrors.inputCostPer1kTokens ? "inputCost-error" : undefined
                        }
                      />
                      {costErrors.inputCostPer1kTokens && (
                        <p id="inputCost-error" className="text-sm text-destructive">
                          {costErrors.inputCostPer1kTokens}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="outputCost">Output Cost per 1K tokens ($)</Label>
                      <Input
                        id="outputCost"
                        type="number"
                        step="0.000001"
                        value={formData.outputCostPer1kTokens || ""}
                        onChange={handleCostChange("outputCostPer1kTokens")}
                        placeholder="0.000000"
                        aria-invalid={!!costErrors.outputCostPer1kTokens}
                        aria-describedby={
                          costErrors.outputCostPer1kTokens ? "outputCost-error" : undefined
                        }
                      />
                      {costErrors.outputCostPer1kTokens && (
                        <p id="outputCost-error" className="text-sm text-destructive">
                          {costErrors.outputCostPer1kTokens}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="cachedCost">Cached Input Cost per 1K ($)</Label>
                      <Input
                        id="cachedCost"
                        type="number"
                        step="0.000001"
                        value={formData.cachedInputCostPer1kTokens || ""}
                        onChange={handleCostChange("cachedInputCostPer1kTokens")}
                        placeholder="0.000000"
                        aria-invalid={!!costErrors.cachedInputCostPer1kTokens}
                        aria-describedby={
                          costErrors.cachedInputCostPer1kTokens ? "cachedCost-error" : undefined
                        }
                      />
                      {costErrors.cachedInputCostPer1kTokens && (
                        <p id="cachedCost-error" className="text-sm text-destructive">
                          {costErrors.cachedInputCostPer1kTokens}
                        </p>
                      )}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-shrink-0 flex items-center justify-between border-t pt-4">
          <div>
            {model && onDelete && (
              <Button
                variant="destructive"
                onClick={() => onDelete(model)}
                disabled={saving}
              >
                <IconTrash className="mr-2 h-4 w-4" />
                Delete Model
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isNew ? "Add Model" : "Save Changes"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
