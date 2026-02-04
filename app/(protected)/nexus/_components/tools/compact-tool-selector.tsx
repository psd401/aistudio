'use client'

import { useState, useEffect, startTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Globe, Code2, Wrench, ChevronDown } from 'lucide-react'
import type { SelectAiModel } from '@/types'
import { getAvailableToolsForModel, type ToolConfig } from '@/lib/tools'
import { createLogger } from '@/lib/client-logger'

const log = createLogger({ moduleName: 'compact-tool-selector' })

interface CompactToolSelectorProps {
  selectedModel: SelectAiModel | null
  enabledTools: string[]
  onToolsChange: (tools: string[]) => void
}

const TOOL_ICONS = {
  webSearch: Globe,
  codeInterpreter: Code2
} as const

export function CompactToolSelector({
  selectedModel,
  enabledTools,
  onToolsChange
}: CompactToolSelectorProps) {
  const [availableTools, setAvailableTools] = useState<ToolConfig[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // Load available tools when model changes
  useEffect(() => {
    if (!selectedModel?.modelId) {
      startTransition(() => { setAvailableTools([]) })
      return
    }

    startTransition(() => { setIsLoading(true) })
    getAvailableToolsForModel(selectedModel.modelId)
      .then(tools => {
        setAvailableTools(tools)
        // Auto-disable tools that are no longer available
        const newEnabledTools = enabledTools.filter(toolName =>
          tools.some(tool => tool.name === toolName)
        )
        if (newEnabledTools.length !== enabledTools.length) {
          onToolsChange(newEnabledTools)
        }
      })
      .catch(() => {
        setAvailableTools([])
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [selectedModel?.modelId, enabledTools, onToolsChange])

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

  if (!selectedModel || availableTools.length === 0) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="outline" 
          size="sm" 
          className="h-8 gap-2 text-xs"
          disabled={isLoading}
        >
          <Wrench className="h-3 w-3" />
          <span className="hidden sm:inline">
            {enabledTools.length > 0 ? `${enabledTools.length} tool${enabledTools.length === 1 ? '' : 's'}` : 'Tools'}
          </span>
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-1.5">
          <p className="text-xs font-medium text-muted-foreground">AI Tools</p>
        </div>
        <DropdownMenuSeparator />
        {availableTools.length === 0 ? (
          <DropdownMenuItem disabled>
            <span className="text-xs">No tools available for this model</span>
          </DropdownMenuItem>
        ) : (
          availableTools.map(tool => {
          const IconComponent = TOOL_ICONS[tool.name as keyof typeof TOOL_ICONS] || Wrench
          const isEnabled = enabledTools.includes(tool.name)
          
          return (
            <DropdownMenuItem
              key={tool.name}
              className="flex items-center justify-between gap-3 px-2 py-2"
              onSelect={(e) => e.preventDefault()} // Prevent dropdown from closing
            >
              <div className="flex items-center gap-2 flex-1">
                <IconComponent className="h-4 w-4 text-muted-foreground" />
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{tool.displayName}</span>
                  <span className="text-xs text-muted-foreground line-clamp-1">
                    {tool.description}
                  </span>
                </div>
              </div>
              <Switch
                checked={isEnabled}
                onCheckedChange={(checked) => handleToolToggle(tool.name, checked)}
                className="data-[state=checked]:bg-primary"
              />
            </DropdownMenuItem>
          )
        }))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}