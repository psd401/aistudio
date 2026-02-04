'use client'

import { useState, useEffect, startTransition } from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Globe, Code2, Search, Brain } from 'lucide-react'
import type { SelectAiModel } from '@/types'
import { getAvailableToolsForModel, type ToolConfig } from '@/lib/tools'

interface ToolSelectorProps {
  selectedModel: SelectAiModel | null
  enabledTools: string[]
  onToolsChange: (tools: string[]) => void
  isLoading?: boolean
}

const TOOL_ICONS = {
  search: Globe,
  code: Code2,
  analysis: Search, 
  creative: Brain
} as const

export function ToolSelector({
  selectedModel,
  enabledTools,
  onToolsChange,
  isLoading = false
}: ToolSelectorProps) {
  const [availableTools, setAvailableTools] = useState<ToolConfig[]>([])
  const [isLoadingTools, setIsLoadingTools] = useState(false)

  // Load available tools when model changes
  useEffect(() => {
    if (!selectedModel?.modelId) {
      startTransition(() => { setAvailableTools([]) })
      return
    }

    startTransition(() => { setIsLoadingTools(true) })

    getAvailableToolsForModel(selectedModel.modelId)
      .then(tools => {
        startTransition(() => {
          setAvailableTools(tools)

          // Auto-disable tools that are no longer available
          const newEnabledTools = enabledTools.filter(toolName =>
            tools.some(tool => tool.name === toolName)
          )
          if (newEnabledTools.length !== enabledTools.length) {
            onToolsChange(newEnabledTools)
          }
        })
      })
      .catch(() => {
        // Log error silently and reset available tools
        startTransition(() => { setAvailableTools([]) })
      })
      .finally(() => {
        startTransition(() => { setIsLoadingTools(false) })
      })
  }, [selectedModel?.modelId, enabledTools, onToolsChange])

  const handleToolToggle = (toolName: string, enabled: boolean) => {
    if (enabled) {
      onToolsChange([...enabledTools, toolName])
    } else {
      onToolsChange(enabledTools.filter(name => name !== toolName))
    }
  }

  if (!selectedModel) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex items-center justify-center p-6">
          <p className="text-sm text-muted-foreground">
            Select a model to see available tools
          </p>
        </CardContent>
      </Card>
    )
  }

  if (isLoadingTools) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">AI Tools</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center p-4">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="ml-2 text-sm text-muted-foreground">Loading tools...</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (availableTools.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">AI Tools</CardTitle>
          <CardDescription className="text-xs">
            No tools available for {selectedModel.name}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            This model does not support any AI tools at this time.
          </p>
        </CardContent>
      </Card>
    )
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
    <Card data-testid="tool-selector">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm">AI Tools</CardTitle>
            <CardDescription className="text-xs">
              {enabledTools.length > 0 
                ? `${enabledTools.length} tool${enabledTools.length === 1 ? '' : 's'} enabled`
                : 'No tools enabled'
              }
            </CardDescription>
          </div>
          {enabledTools.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {enabledTools.length}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
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
                            className="text-xs font-medium cursor-pointer"
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
                          disabled={isLoading}
                          onCheckedChange={(checked) => handleToolToggle(tool.name, checked)}
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
      </CardContent>
    </Card>
  )
}