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
  /** Open workspace object id/slug (`?workspace=`), for the Connect popover (#1786). */
  workspaceId?: string
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
  workspaceId,
}: ComposerControlsProps) {
  return (
    // #1793: `flex-wrap`. With a workspace panel open the chat column is only
    // ~370px wide, while this dock's controls need ~430px — and the composer
    // root clips overflow, so the last control ("Connect") was rendered as
    // "Con…" with no way to reach it. Wrapping to a second line keeps every
    // control whole and clickable at any column width. The advanced controls
    // are ONE group so they wrap together as a unit (never split between rows),
    // and the group's left rule replaces the free-standing divider: it stays
    // attached to the group, so a wrapped second row still reads as part of the
    // same dock rather than as a stray toolbar.
    <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-border">
      <ModelFamilySelector
        mode={routingMode}
        family={modelFamily}
        onModeChange={onRoutingModeChange}
        onFamilyChange={onModelFamilyChange}
      />

      {routingMode === 'advanced' && (
        <div
          className="flex items-center gap-1 border-l border-border pl-1 ml-1"
          data-testid="nexus-composer-advanced-controls"
        >
          <ToolsPopover selectedModel={selectedModel} enabledTools={enabledTools} onToolsChange={onToolsChange} />
          <SkillsPopover disabled />
          <MCPPopover
            enabledConnectors={enabledConnectors}
            onConnectorsChange={onConnectorsChange ?? (() => undefined)}
            disabled={!onConnectorsChange || !selectedModel}
            onReconnectSuccess={onReconnectSuccess}
            workspaceId={workspaceId}
          />
        </div>
      )}
    </div>
  )
}
