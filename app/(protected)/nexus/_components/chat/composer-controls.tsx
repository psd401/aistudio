'use client'

import { ModelSelectorCompact } from './model-selector-compact'
import { ToolsPopover } from './tools-popover'
import { SkillsPopover } from './skills-popover'
import { MCPPopover } from './mcp-popover'
import type { SelectAiModel } from '@/types'

interface ComposerControlsProps {
  // Model selection
  models: SelectAiModel[]
  selectedModel: SelectAiModel | null
  onModelChange: (model: SelectAiModel) => void
  isLoadingModels?: boolean
  // Tool selection
  enabledTools: string[]
  onToolsChange: (tools: string[]) => void
}

/**
 * Control dock for the chat composer.
 * Contains model selector, tools, skills, and MCP connections.
 * Positioned above the input area like Claude.ai.
 */
export function ComposerControls({
  models,
  selectedModel,
  onModelChange,
  isLoadingModels = false,
  enabledTools,
  onToolsChange,
}: ComposerControlsProps) {
  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/50">
      {/* Model Selector */}
      <ModelSelectorCompact
        models={models}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
        isLoading={isLoadingModels}
      />

      {/* Separator */}
      <div className="h-4 w-px bg-border mx-1" />

      {/* Tools */}
      <ToolsPopover
        selectedModel={selectedModel}
        enabledTools={enabledTools}
        onToolsChange={onToolsChange}
      />

      {/* Skills (placeholder) */}
      <SkillsPopover disabled />

      {/* MCP Connections (placeholder) */}
      <MCPPopover disabled />
    </div>
  )
}
