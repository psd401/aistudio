'use client'

import { type PropsWithChildren, useState, useMemo, useCallback } from 'react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronUp, Search, Loader2, Plug } from 'lucide-react'
import { useMessage } from '@assistant-ui/react'
import { useConnectorTools } from './connector-tool-context'

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
type GroupType = 'direct' | 'web-search' | 'connector' | 'mixed'

/**
 * ToolGroup component for consolidating multiple consecutive tool calls
 * Automatically used by assistant-ui when consecutive tool calls are detected
 *
 * Behavior:
 * - Charts (show_chart): Render directly without wrapper
 * - Web searches: Render in collapsible "Web Searches" card
 * - Connector tools: Render in collapsible "Connector Actions" card (purple theme)
 * - Mixed/other tools: Render directly without wrapper
 */
export function ToolGroup({ startIndex, endIndex, children }: PropsWithChildren<ToolGroupProps>) {
  const [isExpanded, setIsExpanded] = useState(false)
  const message = useMessage()
  const connectorCtx = useConnectorTools()

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
        'toolName' in part && connectorCtx.isConnectorTool(part.toolName as string)
      )
      if (allConnector) return 'connector'
    }

    // Check if this looks like a web search group (non-direct, non-connector)
    const hasConnectorTools = connectorCtx && toolCalls.some(part =>
      'toolName' in part && connectorCtx.isConnectorTool(part.toolName as string)
    )
    if (hasConnectorTools) return 'mixed'

    return 'web-search'
  }, [toolCalls, connectorCtx])

  // Direct render (charts, etc.)
  if (groupType === 'direct') {
    return <div className="space-y-4">{children}</div>
  }

  // Mixed groups or connector tools that also contain non-connector tools: render directly
  if (groupType === 'mixed') {
    return <div className="space-y-4">{children}</div>
  }

  const isRunning = toolCalls.some(part =>
    'result' in part && part.result === undefined
  )

  const toolCount = endIndex - startIndex + 1

  // Connector tool group
  if (groupType === 'connector') {
    // Get the connector server name from the first tool
    const firstToolName = toolCalls[0] && 'toolName' in toolCalls[0]
      ? toolCalls[0].toolName as string
      : undefined
    const connectorInfo = firstToolName ? connectorCtx?.getConnectorInfo(firstToolName) : undefined
    const serverLabel = connectorInfo?.serverName || 'Connector'

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

  // Web search group (default)
  return (
    <Card className="mb-4 border-blue-200 bg-blue-50/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* Show spinner ONLY when searches are actually running */}
            {isRunning ? (
              <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />
            ) : (
              <Search className="h-4 w-4 text-blue-600" />
            )}
            <span className="text-sm font-medium text-blue-900">
              Web Searches ({toolCount})
            </span>
            {/* Show "Searching..." text ONLY when active */}
            {isRunning && (
              <span className="text-xs text-blue-600 animate-pulse">Searching...</span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleExpanded}
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
