'use client'

import { useState, useEffect, useCallback, useRef, memo, startTransition } from 'react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Wrench, Globe, Code2, ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getAvailableToolsForModel, type ToolConfig } from '@/lib/tools/client-tool-registry'
import type { SelectAiModel } from '@/types'

const WEB_SEARCH_TOOL_NAME = 'webSearch'

interface ToolsPopoverProps {
  selectedModel: SelectAiModel | null
  enabledTools: string[]
  onToolsChange: (tools: string[]) => void
  /** Pass true in non-chat contexts (prompt library) to suppress auto-enabling tools */
  disableAutoEnable?: boolean
}

// Tool-specific icons
const TOOL_ICONS: Record<string, typeof Wrench> = {
  webSearch: Globe,
  codeInterpreter: Code2,
  generateImage: ImageIcon,
}

// Extracted component to avoid inline functions and provide proper accessibility
interface ToolItemProps {
  tool: ToolConfig
  isEnabled: boolean
  onToggle: (toolName: string) => void
}

const ToolItem = memo(function ToolItem({ tool, isEnabled, onToggle }: ToolItemProps) {
  const IconComponent = TOOL_ICONS[tool.name] || Wrench

  const handleClick = useCallback(() => {
    onToggle(tool.name)
  }, [tool.name, onToggle])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle(tool.name)
    }
  }, [tool.name, onToggle])

  const handleSwitchClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])

  return (
    <div
      role="button"
      tabIndex={0}
      className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50 cursor-pointer"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center gap-2 min-w-0">
        <IconComponent className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{tool.displayName}</p>
          <p className="text-xs text-muted-foreground truncate">{tool.description}</p>
        </div>
      </div>
      <Switch
        checked={isEnabled}
        onCheckedChange={handleClick}
        onClick={handleSwitchClick}
        className="shrink-0"
      />
    </div>
  )
})

export function ToolsPopover({
  selectedModel,
  enabledTools,
  onToolsChange,
  disableAutoEnable = false,
}: ToolsPopoverProps) {
  const [availableTools, setAvailableTools] = useState<ToolConfig[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [open, setOpen] = useState(false)

  // Refs to access current values without adding them as effect dependencies
  const enabledToolsRef = useRef(enabledTools)
  const onToolsChangeRef = useRef(onToolsChange)

  // Keep refs in sync with props
  useEffect(() => {
    enabledToolsRef.current = enabledTools
    onToolsChangeRef.current = onToolsChange
  })

  // Load available tools when model changes
  const selectedModelId = selectedModel?.modelId
  useEffect(() => {
    if (!selectedModelId) {
      startTransition(() => { setAvailableTools([]) })
      return
    }

    let cancelled = false
    startTransition(() => { setIsLoading(true) })
    getAvailableToolsForModel(selectedModelId)
      .then(tools => {
        if (cancelled) return

        setAvailableTools(tools)

        const availableToolNames = tools.map(t => t.name)
        const currentEnabledTools = enabledToolsRef.current
        const validEnabledTools = currentEnabledTools.filter(tool =>
          availableToolNames.includes(tool)
        )
        const supportsWebSearch = !disableAutoEnable && availableToolNames.includes(WEB_SEARCH_TOOL_NAME)

        if (validEnabledTools.length !== currentEnabledTools.length) {
          // Some previously-enabled tools are no longer available for this model.
          // If stripping leaves nothing and webSearch is available, auto-enable it —
          // the user didn't opt out of search, they just had a different tool active.
          const finalTools = validEnabledTools.length === 0 && supportsWebSearch
            ? [WEB_SEARCH_TOOL_NAME]
            : validEnabledTools
          onToolsChangeRef.current(finalTools)
        } else if (currentEnabledTools.length === 0 && supportsWebSearch) {
          // No tools currently enabled — auto-enable web search as a sensible default
          onToolsChangeRef.current([WEB_SEARCH_TOOL_NAME])
        }
      })
      .finally(() => { if (!cancelled) setIsLoading(false) })

    return () => { cancelled = true }
  }, [selectedModelId, disableAutoEnable])

  const handleToolToggle = useCallback((toolName: string) => {
    if (enabledTools.includes(toolName)) {
      onToolsChange(enabledTools.filter(t => t !== toolName))
    } else {
      onToolsChange([...enabledTools, toolName])
    }
  }, [enabledTools, onToolsChange])

  const enabledCount = enabledTools.length

  // Always show button (disabled when no tools available)
  const hasTools = availableTools.length > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 gap-1.5 text-xs',
            enabledCount > 0 && 'text-primary'
          )}
          disabled={!selectedModel || isLoading}
          title={!selectedModel ? 'Select a model first' : !hasTools ? 'No tools available for this model' : 'Configure tools'}
        >
          <Wrench className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Tools</span>
          {enabledCount > 0 && (
            <Badge variant="secondary" className="h-5 px-1.5 text-xs">
              {enabledCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="p-3 border-b">
          <h4 className="font-medium text-sm">AI Tools</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            Enable tools to extend AI capabilities
          </p>
        </div>
        <div className="p-2">
          {!hasTools ? (
            <p className="text-xs text-muted-foreground p-2 text-center">
              No tools available for this model
            </p>
          ) : (
            <div className="space-y-1">
              {availableTools.map((tool) => (
                <ToolItem
                  key={tool.name}
                  tool={tool}
                  isEnabled={enabledTools.includes(tool.name)}
                  onToggle={handleToolToggle}
                />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
