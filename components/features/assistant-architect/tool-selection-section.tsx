'use client'

import { useState, useEffect, useCallback, startTransition } from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Globe, Code2, Search, Brain, Info } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { SelectAiModel } from '@/types'
import { getAvailableToolsForModel, type ToolConfig } from '@/lib/tools'
import { createLogger } from '@/lib/client-logger'

const log = createLogger({ moduleName: 'tool-selection-section' })

interface ToolSelectionSectionProps {
  selectedModelId: number | null
  enabledTools: string[]
  onToolsChange: (tools: string[]) => void
  models: SelectAiModel[]
  disabled?: boolean
}

const TOOL_ICONS = {
  search: Globe,
  code: Code2,
  analysis: Search,
  creative: Brain,
  media: Brain
} as const

export function ToolSelectionSection({
  selectedModelId,
  enabledTools,
  onToolsChange,
  models,
  disabled = false
}: ToolSelectionSectionProps) {
  const [availableTools, setAvailableTools] = useState<ToolConfig[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Get selected model object
  const selectedModel = selectedModelId
    ? models.find(m => m.id === selectedModelId)
    : null

  // Auto-disable tools that are no longer available when tools list changes
  const filterIncompatibleTools = useCallback((tools: ToolConfig[]) => {
    const newEnabledTools = enabledTools.filter(toolName =>
      tools.some(tool => tool.name === toolName)
    )
    if (newEnabledTools.length !== enabledTools.length) {
      log.debug('Auto-disabling unavailable tools', {
        before: enabledTools,
        after: newEnabledTools
      })
      onToolsChange(newEnabledTools)
    }
  }, [enabledTools, onToolsChange])

  // Load available tools when model changes
  useEffect(() => {
    if (!selectedModel?.modelId) {
      startTransition(() => {
        setAvailableTools([])
        setError(null)
      })
      return
    }

    startTransition(() => { setIsLoading(true) })
    log.debug('Loading tools for model', {
      modelId: selectedModel.modelId,
      modelName: selectedModel.name
    })

    getAvailableToolsForModel(selectedModel.modelId)
      .then(tools => {
        log.debug('Tools loaded', { tools: tools.map(t => t.name) })
        setError(null) // Clear any previous errors
        setAvailableTools(tools)
        filterIncompatibleTools(tools)
      })
      .catch(error => {
        log.error('Failed to load tools', { error })
        setError('Failed to load available tools. Please try again.')
        setAvailableTools([])
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [selectedModel?.modelId, selectedModel?.name, filterIncompatibleTools])

  const handleToolToggle = (toolName: string, enabled: boolean) => {
    log.debug('Tool toggle', { toolName, enabled, currentEnabledTools: enabledTools })

    if (enabled) {
      const newTools = [...enabledTools, toolName]
      log.debug('Enabling tool', { toolName, newTools })
      onToolsChange(newTools)
    } else {
      const newTools = enabledTools.filter(name => name !== toolName)
      log.debug('Disabling tool', { toolName, newTools })
      onToolsChange(newTools)
    }
  }

  // Don't render if no model is selected
  if (!selectedModel) {
    return null
  }

  // Group tools by category
  const toolsByCategory = availableTools.reduce((acc, tool) => {
    if (!acc[tool.category]) {
      acc[tool.category] = []
    }
    acc[tool.category].push(tool)
    return acc
  }, {} as Record<string, ToolConfig[]>)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">Available Tools</Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-4 w-4 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs text-sm">
                Enable AI tools for this prompt based on your selected model&apos;s capabilities.
                Tools will be available during prompt execution.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {enabledTools.length > 0 && (
          <Badge variant="secondary" className="text-xs">
            {enabledTools.length} enabled
          </Badge>
        )}
      </div>

      {error ? (
        <div className="p-4 border rounded-lg bg-destructive/10 border-destructive/20">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center p-4 border rounded-lg bg-muted/50">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="ml-2 text-sm text-muted-foreground">Loading tools...</span>
        </div>
      ) : availableTools.length === 0 ? (
        <div className="p-4 border rounded-lg bg-muted/50">
          <p className="text-sm text-muted-foreground text-center">
            No tools available for {selectedModel.name}
          </p>
          <p className="text-xs text-muted-foreground text-center mt-1">
            This model does not support any AI tools at this time.
          </p>
        </div>
      ) : (
        <div className="space-y-4 border rounded-lg p-4 bg-muted/20">
          {Object.entries(toolsByCategory).map(([category, tools], categoryIndex) => {
            const IconComponent = TOOL_ICONS[category as keyof typeof TOOL_ICONS] || Brain

            return (
              <div key={category}>
                {categoryIndex > 0 && <Separator className="my-3" />}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <IconComponent className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs font-medium capitalize text-muted-foreground">
                      {category}
                    </span>
                  </div>
                  <div className="space-y-3 pl-5">
                    {tools.map(tool => {
                      const isEnabled = enabledTools.includes(tool.name)

                      return (
                        <div
                          key={tool.name}
                          className="flex items-start justify-between space-x-3"
                        >
                          <div className="flex-1 space-y-1">
                            <Label
                              htmlFor={`tool-${tool.name}`}
                              className="text-sm font-medium cursor-pointer"
                            >
                              {tool.displayName}
                            </Label>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {tool.description}
                            </p>
                          </div>
                          <Switch
                            id={`tool-${tool.name}`}
                            checked={isEnabled}
                            disabled={disabled || isLoading}
                            onCheckedChange={(checked) => handleToolToggle(tool.name, checked)}
                            aria-label={`Enable ${tool.displayName}: ${tool.description}`}
                            className="mt-0.5"
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}