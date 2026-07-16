'use client'

import { ModelFamilySelector } from './model-family-selector'
import { ToolsPopover } from './tools-popover'
import { SkillsPopover } from './skills-popover'
import { MCPPopover } from './mcp-popover'
import type { SelectAiModel } from '@/types'
import type { NexusExperienceMode, NexusModelFamily } from '@/lib/nexus/model-router/types'

interface ComposerControlsProps {
  // Model selection
  selectedModel: SelectAiModel | null
  routingMode: NexusExperienceMode
  modelFamily: NexusModelFamily
  onRoutingModeChange: (mode: NexusExperienceMode) => void
  onModelFamilyChange: (family: NexusModelFamily) => void
  // Tool selection
  enabledTools: string[]
  onToolsChange: (tools: string[]) => void
  // Connector selection (optional — MCPPopover shows disabled when not provided)
  enabledConnectors?: string[]
  onConnectorsChange?: (connectors: string[]) => void
  onReconnectSuccess?: (serverId: string) => void
}

/**
 * Control dock for the chat composer.
 * Contains model selector, tools, skills, and MCP connections.
 * Positioned above the input area like Claude.ai.
 */
export function ComposerControls({
  selectedModel,
  routingMode,
  modelFamily,
  onRoutingModeChange,
  onModelFamilyChange,
  enabledTools,
  onToolsChange,
  enabledConnectors = [],
  onConnectorsChange,
  onReconnectSuccess,
}: ComposerControlsProps) {
  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/50">
      <ModelFamilySelector
        mode={routingMode}
        family={modelFamily}
        onModeChange={onRoutingModeChange}
        onFamilyChange={onModelFamilyChange}
      />

      {routingMode === 'advanced' && (
        <>
          <div className="h-4 w-px bg-border mx-1" />
          <ToolsPopover selectedModel={selectedModel} enabledTools={enabledTools} onToolsChange={onToolsChange} />
          <SkillsPopover disabled />
          <MCPPopover
            enabledConnectors={enabledConnectors}
            onConnectorsChange={onConnectorsChange ?? (() => undefined)}
            disabled={!onConnectorsChange || !selectedModel}
            onReconnectSuccess={onReconnectSuccess}
          />
        </>
      )}
    </div>
  )
}
