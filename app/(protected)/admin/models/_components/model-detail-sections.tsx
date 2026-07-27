"use client"

import type { ChangeEvent, RefObject } from "react"
import { IconChevronRight, IconCopy, IconLoader2, IconTrash } from "@tabler/icons-react"
import { ResourceGrantsEditor } from "@/components/features/resource-grants"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MultiSelect, type MultiSelectOption } from "@/components/ui/multi-select"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { SelectAiModel } from "@/types/db-types"
import type {
  CostErrors,
  CostField,
  ModelFormData,
  UpdateModelField,
} from "./model-detail-form"
import { PROVIDER_OPTIONS } from "./provider-badge"

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

interface IdentityPanelProps {
  copyId: () => void
  firstInputRef: RefObject<HTMLInputElement | null>
  formData: ModelFormData
  model: SelectAiModel | null
  updateField: UpdateModelField
}

export function IdentityPanel({
  copyId,
  firstInputRef,
  formData,
  model,
  updateField,
}: IdentityPanelProps) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Identity & Connection</h3>
        <div className="space-y-4">
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

          <div className="space-y-2">
            <Label htmlFor="name">Display Name *</Label>
            <Input
              ref={firstInputRef}
              id="name"
              value={formData.name}
              onChange={(event) => updateField("name", event.target.value)}
              placeholder="GPT-4 Turbo"
            />
          </div>

          <div className="space-y-2">
            <Label>Provider *</Label>
            <Select
              value={formData.provider}
              onValueChange={(value) => updateField("provider", value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="modelId">Model ID *</Label>
            <Input
              id="modelId"
              value={formData.modelId}
              onChange={(event) => updateField("modelId", event.target.value)}
              placeholder="gpt-4-turbo"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              The API identifier used to call this model
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(event) =>
                updateField("description", event.target.value)
              }
              placeholder="Model description..."
              rows={3}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

interface ConfigurationPanelProps {
  formData: ModelFormData
  isNew: boolean
  model: SelectAiModel | null
  updateField: UpdateModelField
}

export function ConfigurationPanel({
  formData,
  isNew,
  model,
  updateField,
}: ConfigurationPanelProps) {
  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Configuration</h3>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="maxTokens">Max Tokens</Label>
          <Input
            id="maxTokens"
            type="number"
            value={formData.maxTokens}
            onChange={(event) =>
              updateField(
                "maxTokens",
                Number.parseInt(event.target.value) || 4096
              )
            }
          />
        </div>

        <div className="space-y-2">
          <Label>Capabilities</Label>
          <MultiSelect
            options={capabilityOptions}
            value={formData.capabilitiesList}
            onChange={(value) => updateField("capabilitiesList", value)}
            placeholder="Select capabilities"
            allowCustom
            customPlaceholder="Add custom capability..."
            className="w-full"
          />
        </div>

        <div className="space-y-2">
          <Label>Access</Label>
          {isNew || !model ? (
            <p className="text-xs text-muted-foreground">
              New models are available to everyone. Save the model first, then
              reopen it to restrict access to specific roles or Google groups.
            </p>
          ) : (
            <ResourceGrantsEditor
              resourceType="model"
              resourceId={model.id}
              resourceLabel={model.name}
            />
          )}
        </div>
      </div>
    </div>
  )
}

interface AvailabilityPanelProps {
  formData: ModelFormData
  updateField: UpdateModelField
}

export function AvailabilityPanel({
  formData,
  updateField,
}: AvailabilityPanelProps) {
  const options = [
    {
      checked: formData.active,
      description: "Model is available for use",
      field: "active",
      label: "Active",
    },
    {
      checked: formData.nexusEnabled,
      description: "Available in Nexus chat and Model Compare",
      field: "nexusEnabled",
      label: "Nexus / Compare Enabled",
    },
    {
      checked: formData.architectEnabled,
      description: "Available in Assistant Architect",
      field: "architectEnabled",
      label: "Assistant Architect Enabled",
    },
  ] as const

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Availability</h3>
      <div className="space-y-4">
        {options.map((option) => (
          <div
            className="flex items-center justify-between"
            key={option.field}
          >
            <div className="space-y-0.5">
              <Label htmlFor={option.field}>{option.label}</Label>
              <p className="text-xs text-muted-foreground">
                {option.description}
              </p>
            </div>
            <Switch
              id={option.field}
              checked={option.checked}
              onCheckedChange={(value) =>
                updateField(option.field, value)
              }
            />
          </div>
        ))}
      </div>
    </div>
  )
}

interface CostSettingsProps {
  costErrors: CostErrors
  costOpen: boolean
  formData: ModelFormData
  handleCostChange: (
    field: CostField
  ) => (event: ChangeEvent<HTMLInputElement>) => void
  setCostOpen: (open: boolean) => void
}

const costFields = [
  {
    field: "inputCostPer1kTokens",
    id: "inputCost",
    label: "Input Cost per 1K tokens ($)",
  },
  {
    field: "outputCostPer1kTokens",
    id: "outputCost",
    label: "Output Cost per 1K tokens ($)",
  },
  {
    field: "cachedInputCostPer1kTokens",
    id: "cachedCost",
    label: "Cached Input Cost per 1K ($)",
  },
  {
    field: "cacheWriteCostPer1kTokens",
    id: "cacheWriteCost",
    label: "Cache Write Cost per 1K ($)",
  },
] as const

export function CostSettings({
  costErrors,
  costOpen,
  formData,
  handleCostChange,
  setCostOpen,
}: CostSettingsProps) {
  return (
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
          {costFields.map(({ field, id, label }) => {
            const error = costErrors[field]
            const errorId = `${id}-error`
            return (
              <div className="space-y-2" key={field}>
                <Label htmlFor={id}>{label}</Label>
                <Input
                  id={id}
                  type="number"
                  step="0.000001"
                  value={formData[field] || ""}
                  onChange={handleCostChange(field)}
                  placeholder="0.000000"
                  aria-invalid={!!error}
                  aria-describedby={error ? errorId : undefined}
                />
                {error && (
                  <p id={errorId} className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

interface ModelModalFooterProps {
  handleSave: () => void
  isNew: boolean
  model: SelectAiModel | null
  onDelete?: (model: SelectAiModel) => void
  onOpenChange: (open: boolean) => void
  saving: boolean
}

export function ModelModalFooter({
  handleSave,
  isNew,
  model,
  onDelete,
  onOpenChange,
  saving,
}: ModelModalFooterProps) {
  return (
    <div className="flex-shrink-0 flex items-center justify-between border-t pt-4 px-6 pb-6">
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
        <Button
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isNew ? "Add Model" : "Save Changes"}
        </Button>
      </div>
    </div>
  )
}

export { Separator }
