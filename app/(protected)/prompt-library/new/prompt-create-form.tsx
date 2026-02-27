"use client"

import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ModelSelectorCompact } from "@/app/(protected)/nexus/_components/chat/model-selector-compact"
import { ToolsPopover } from "@/app/(protected)/nexus/_components/chat/tools-popover"
import { MCPPopover } from "@/app/(protected)/nexus/_components/chat/mcp-popover"
import { TagInput } from "../_components/tag-input"
import type { SelectAiModel } from "@/types"
import type { PromptVisibility } from "@/lib/prompt-library/types"

interface FormData {
  title: string
  content: string
  description: string
  visibility: PromptVisibility
  tags: string[]
}

interface PromptCreateFormProps {
  formData: FormData
  onFormDataChange: (data: FormData) => void
  models: SelectAiModel[]
  modelsLoading: boolean
  selectedModel: SelectAiModel | null
  onModelChange: (model: SelectAiModel) => void
  enabledTools: string[]
  onToolsChange: (tools: string[]) => void
  enabledConnectors: string[]
  onConnectorsChange: (connectors: string[]) => void
}

export function PromptCreateForm({
  formData,
  onFormDataChange,
  models,
  modelsLoading,
  selectedModel,
  onModelChange,
  enabledTools,
  onToolsChange,
  enabledConnectors,
  onConnectorsChange,
}: PromptCreateFormProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Prompt Details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Title */}
        <div className="space-y-2">
          <Label htmlFor="title">Title * ({formData.title.length}/255)</Label>
          <Input
            id="title"
            value={formData.title}
            onChange={(e) => onFormDataChange({ ...formData, title: e.target.value })}
            placeholder="Enter prompt title"
            maxLength={255}
            aria-required="true"
            aria-invalid={!formData.title}
          />
        </div>

        {/* Description */}
        <div className="space-y-2">
          <Label htmlFor="description">Description ({formData.description.length}/1000)</Label>
          <Textarea
            id="description"
            value={formData.description}
            onChange={(e) => onFormDataChange({ ...formData, description: e.target.value })}
            placeholder="Enter a brief description"
            rows={3}
            maxLength={1000}
          />
        </div>

        {/* Content */}
        <div className="space-y-2">
          <Label htmlFor="content">Prompt Content * ({formData.content.length}/50000)</Label>
          <Textarea
            id="content"
            value={formData.content}
            onChange={(e) => onFormDataChange({ ...formData, content: e.target.value })}
            placeholder="Enter your prompt content"
            rows={10}
            className="font-mono"
            maxLength={50000}
            aria-required="true"
            aria-invalid={!formData.content}
          />
          <p className="text-xs text-muted-foreground">
            Use variables like {`{{variable_name}}`} for dynamic content
          </p>
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <Label htmlFor="tags">Tags</Label>
          <TagInput
            value={formData.tags}
            onChange={(tags) => onFormDataChange({ ...formData, tags })}
          />
        </div>

        {/* Visibility */}
        <div className="space-y-2">
          <Label htmlFor="visibility">Visibility</Label>
          <Select
            value={formData.visibility}
            onValueChange={(value: PromptVisibility) =>
              onFormDataChange({ ...formData, visibility: value })
            }
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="private">Private</SelectItem>
              <SelectItem value="public">Public</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Public prompts will be visible to all users after moderation
          </p>
        </div>

        {/* Chat Configuration */}
        <div className="space-y-3">
          <Label>Chat Configuration</Label>
          <p className="text-xs text-muted-foreground">
            Optionally configure a model, tools, and connectors that will be pre-selected when this prompt is used in Nexus.
          </p>
          <div className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <ModelSelectorCompact
                models={models}
                selectedModel={selectedModel}
                onModelChange={onModelChange}
                isLoading={modelsLoading}
              />
              <ToolsPopover
                selectedModel={selectedModel}
                enabledTools={enabledTools}
                onToolsChange={onToolsChange}
              />
              <MCPPopover
                enabledConnectors={enabledConnectors}
                onConnectorsChange={onConnectorsChange}
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
