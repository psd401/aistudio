'use client'

import { type PropsWithChildren, useState, useMemo, useCallback } from 'react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronUp, Wrench, Loader2, Plug } from 'lucide-react'
import { useMessage } from '@assistant-ui/react'
import { useConnectorToolsOptional } from './connector-tool-context'

interface ToolGroupProps {
  startIndex: number
  endIndex: number
}

// Tools that should render directly without the collapsible wrapper
const DIRECT_RENDER_TOOLS = [
  'show_chart',
  'search_graph_nodes',
  'propose_decision',
  'commit_decision',
]

/**
 * Detect group type based on tool contents and connector context.
 */
type GroupType = 'direct' | 'generic' | 'connector' | 'mixed'

/**
 * ToolGroup component for consolidating multiple consecutive tool calls
 * Automatically used by assistant-ui when consecutive tool calls are detected
 *
 * Behavior:
 * - Charts (show_chart): Render directly without wrapper
 * - Generic tools: Render in collapsible "Tool Actions" card
 * - Connector tools: Render in collapsible "Connector Actions" card (purple theme)
 * - Mixed/other tools: Render directly without wrapper
 */
export function ToolGroup({ startIndex, endIndex, children }: PropsWithChildren<ToolGroupProps>) {
  const [isExpanded, setIsExpanded] = useState(false)
  const message = useMessage()
  const connectorCtx = useConnectorToolsOptional()

  // Memoized toggle handler to avoid creating new function on each render
  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev)
  }, [])

  // Get all tool calls in this group
  const toolCalls = useMemo(() => {
    return message.content
      .slice(startIndex, endIndex + 1)
      .filter(part => part.type === 'tool-call')
  }, [message.content, startIndex, endIndex])

  // Determine group type
  const groupType = useMemo<GroupType>(() => {
    const allDirect = toolCalls.every(part =>
      'toolName' in part && DIRECT_RENDER_TOOLS.includes(part.toolName as string)
    )
    if (allDirect) return 'direct'

    // Check if all tools are connector tools
    if (connectorCtx) {
      const allConnector = toolCalls.every(part =>
        'toolName' in part && connectorCtx.getConnectorInfo(part.toolName as string)
      )
      if (allConnector) return 'connector'
    }

    // Mixed: some connector, some not — render without wrapper
    const hasConnectorTools = connectorCtx && toolCalls.some(part =>
      'toolName' in part && connectorCtx.getConnectorInfo(part.toolName as string)
    )
    if (hasConnectorTools) return 'mixed'

    return 'generic'
  }, [toolCalls, connectorCtx])

  const isRunning = toolCalls.some(part =>
    'result' in part && part.result === undefined
  )

  const toolCount = endIndex - startIndex + 1

  // Collect unique server names for connector groups (memoized to avoid O(tools) on every render).
  // Must be called before early returns to satisfy React hooks ordering rules.
  // Depend on getConnectorInfo (stable useCallback) rather than full connectorCtx to avoid
  // re-running when unrelated context state (e.g. failedServerIds) changes.
  const getConnectorInfo = connectorCtx?.getConnectorInfo
  const connectorServerNames = useMemo(() => {
    if (groupType !== 'connector' || !getConnectorInfo) return []
    return [...new Set(
      toolCalls
        .filter(part => 'toolName' in part)
        .map(part => getConnectorInfo(part.toolName as string)?.serverName)
        .filter((name): name is string => !!name)
    )]
  }, [groupType, toolCalls, getConnectorInfo])

  // Direct render (charts, etc.) and mixed groups: render without collapsible wrapper
  if (groupType === 'direct' || groupType === 'mixed') {
    return <div className="space-y-4">{children}</div>
  }

  // Connector tool group
  if (groupType === 'connector') {
    const serverLabel = connectorServerNames.length === 1
      ? connectorServerNames[0]
      : connectorServerNames.length > 1
        ? 'Connectors'
        : 'Connector'

    return (
      <Card className="mb-4 border-purple-200 bg-purple-50/30">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isRunning ? (
                <Loader2 className="h-4 w-4 text-purple-600 animate-spin" />
              ) : (
                <Plug className="h-4 w-4 text-purple-600" />
              )}
              <span className="text-sm font-medium text-purple-900">
                {serverLabel} Actions ({toolCount})
              </span>
              {isRunning && (
                <span className="text-xs text-purple-600 animate-pulse">Running...</span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleExpanded}
              aria-expanded={isExpanded}
              aria-label={isExpanded ? 'Hide connector actions' : 'Show connector actions'}
              className="h-8 text-purple-700 hover:text-purple-900 hover:bg-purple-100"
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="h-4 w-4 mr-1" />
                  Hide
                </>
              ) : (
                <>
                  <ChevronDown className="h-4 w-4 mr-1" />
                  Show
                </>
              )}
            </Button>
          </div>
        </CardHeader>
        {isExpanded && (
          <CardContent className="space-y-2">
            {children}
          </CardContent>
        )}
      </Card>
    )
  }

  // Generic tool group (default for non-connector, non-direct tools)
  return (
    <Card className="mb-4 border-blue-200 bg-blue-50/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isRunning ? (
              <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />
            ) : (
              <Wrench className="h-4 w-4 text-blue-600" />
            )}
            <span className="text-sm font-medium text-blue-900">
              Tool Actions ({toolCount})
            </span>
            {isRunning && (
              <span className="text-xs text-blue-600 animate-pulse">Running...</span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleExpanded}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Hide tool actions' : 'Show tool actions'}
            className="h-8 text-blue-700 hover:text-blue-900 hover:bg-blue-100"
          >
            {isExpanded ? (
              <>
                <ChevronUp className="h-4 w-4 mr-1" />
                Hide
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4 mr-1" />
                Show
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      {isExpanded && (
        <CardContent className="space-y-2">
          {children}
        </CardContent>
      )}
    </Card>
  )
}
