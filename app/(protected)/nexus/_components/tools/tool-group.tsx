'use client'

import { type PropsWithChildren, useState, useMemo, useCallback } from 'react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronUp, Search, Loader2 } from 'lucide-react'
import { useMessage } from '@assistant-ui/react'

interface ToolGroupProps {
  startIndex: number
  endIndex: number
}

// Tools that should render directly without the collapsible wrapper
const DIRECT_RENDER_TOOLS = ['show_chart']

/**
 * ToolGroup component for consolidating multiple consecutive tool calls
 * Automatically used by assistant-ui when consecutive tool calls are detected
 *
 * Behavior:
 * - Charts (show_chart): Render directly without wrapper
 * - Web searches: Render in collapsible "Web Searches" card
 * - Other tools: Render directly without wrapper
 */
export function ToolGroup({ startIndex, endIndex, children }: PropsWithChildren<ToolGroupProps>) {
  const [isExpanded, setIsExpanded] = useState(false)
  const message = useMessage()

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

  // If this group contains ONLY direct-render tools (like charts), render children directly
  const allDirectRender = useMemo(() => {
    return toolCalls.every(part =>
      'toolName' in part && DIRECT_RENDER_TOOLS.includes(part.toolName as string)
    )
  }, [toolCalls])

  if (allDirectRender) {
    // Render charts and similar tools directly without any wrapper
    return <div className="space-y-4">{children}</div>
  }

  // For web searches and mixed groups, use the collapsible card
  const isSearching = toolCalls.some(part =>
    'result' in part && part.result === undefined
  )

  const toolCount = endIndex - startIndex + 1

  return (
    <Card className="mb-4 border-blue-200 bg-blue-50/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* Show spinner ONLY when searches are actually running */}
            {isSearching ? (
              <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />
            ) : (
              <Search className="h-4 w-4 text-blue-600" />
            )}
            <span className="text-sm font-medium text-blue-900">
              Web Searches ({toolCount})
            </span>
            {/* Show "Searching..." text ONLY when active */}
            {isSearching && (
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
