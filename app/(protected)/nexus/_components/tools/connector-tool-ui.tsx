'use client'

import { useState, useMemo } from 'react'
import type { ToolCallMessagePartComponent } from '@assistant-ui/react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ChevronDown,
  ChevronUp,
  Plug,
  Loader2,
  AlertCircle,
  ExternalLink,
  CheckCircle2,
  ImageIcon,
  FileText,
  RefreshCw,
} from 'lucide-react'
import { useConnectorTools, type ConnectorServerInfo } from './connector-tool-context'

/**
 * Format a tool name for display.
 * Converts snake_case/camelCase to human-readable form.
 */
function formatToolName(toolName: string): string {
  return toolName
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Summarize tool arguments for compact display.
 * Shows first 2-3 key=value pairs.
 */
function summarizeArgs(argsText: string): string {
  try {
    const args = JSON.parse(argsText)
    if (typeof args !== 'object' || args === null) return argsText

    const entries = Object.entries(args)
    if (entries.length === 0) return 'No arguments'

    const summary = entries.slice(0, 3).map(([key, value]) => {
      const displayValue = typeof value === 'string'
        ? (value.length > 40 ? `"${value.substring(0, 37)}..."` : `"${value}"`)
        : JSON.stringify(value)
      return `${key}: ${displayValue}`
    })

    if (entries.length > 3) {
      summary.push(`+${entries.length - 3} more`)
    }

    return summary.join(', ')
  } catch {
    return argsText.length > 80 ? `${argsText.substring(0, 77)}...` : argsText
  }
}

/**
 * Detect result type for rendering.
 */
interface ParsedResult {
  type: 'text' | 'image' | 'link' | 'error' | 'json'
  text?: string
  url?: string
  mimeType?: string
}

function parseResult(result: unknown): ParsedResult[] {
  if (result === undefined || result === null) return []

  // MCP tool results follow the McpToolResult format: { content: McpContentItem[] }
  if (typeof result === 'object' && 'content' in (result as Record<string, unknown>)) {
    const mcpResult = result as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }

    if (mcpResult.isError) {
      const errorText = mcpResult.content
        ?.filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n') || 'Tool execution failed'
      return [{ type: 'error', text: errorText }]
    }

    return (mcpResult.content || []).map(item => {
      if (item.type === 'image') {
        return { type: 'image' as const, url: item.data, mimeType: item.mimeType }
      }
      if (item.type === 'resource' && item.text) {
        // Check if text looks like a URL
        if (/^https?:\/\//.test(item.text)) {
          return { type: 'link' as const, url: item.text, mimeType: item.mimeType }
        }
      }
      return { type: 'text' as const, text: item.text || '' }
    })
  }

  // String result
  if (typeof result === 'string') {
    if (/^https?:\/\//.test(result)) {
      return [{ type: 'link', url: result }]
    }
    return [{ type: 'text', text: result }]
  }

  // Fallback: JSON
  return [{ type: 'json', text: JSON.stringify(result, null, 2) }]
}

/**
 * Connector icon component.
 * Falls back to Plug icon if no custom icon URL.
 */
function ConnectorIcon({ info, size = 16 }: { info: ConnectorServerInfo; size?: number }) {
  if (info.iconUrl) {
    return (
      <img
        src={info.iconUrl}
        alt={info.serverName}
        width={size}
        height={size}
        className="rounded-sm"
      />
    )
  }
  return <Plug className="text-purple-600" style={{ width: size, height: size }} />
}

// ============================================================================
// Result Renderers
// ============================================================================

function TextResult({ text }: { text: string }) {
  return (
    <div className="text-sm text-gray-800 whitespace-pre-wrap break-words">
      {text}
    </div>
  )
}

function ImageResult({ url, mimeType }: { url: string; mimeType?: string }) {
  return (
    <div className="mt-2">
      <img
        src={url.startsWith('data:') ? url : `data:${mimeType || 'image/png'};base64,${url}`}
        alt="Connector result"
        className="max-w-xs rounded-lg border shadow-sm"
      />
    </div>
  )
}

function LinkResult({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-sm text-purple-700 hover:text-purple-900 hover:underline"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {url.length > 60 ? `${url.substring(0, 57)}...` : url}
    </a>
  )
}

function ErrorResult({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2.5">
      <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
      <span className="text-sm text-red-800">{text}</span>
    </div>
  )
}

function JsonResult({ text }: { text: string }) {
  return (
    <pre className="text-xs bg-gray-50 p-2 rounded overflow-x-auto max-h-48 text-gray-800">
      {text}
    </pre>
  )
}

function ResultRenderer({ parsed }: { parsed: ParsedResult[] }) {
  if (parsed.length === 0) return null

  return (
    <div className="space-y-2">
      {parsed.map((item, i) => {
        switch (item.type) {
          case 'text': return <TextResult key={i} text={item.text || ''} />
          case 'image': return <ImageResult key={i} url={item.url || ''} mimeType={item.mimeType} />
          case 'link': return <LinkResult key={i} url={item.url || ''} />
          case 'error': return <ErrorResult key={i} text={item.text || 'Unknown error'} />
          case 'json': return <JsonResult key={i} text={item.text || '{}'} />
        }
      })}
    </div>
  )
}

// ============================================================================
// Result type icon helper
// ============================================================================

function ResultTypeIcon({ parsed }: { parsed: ParsedResult[] }) {
  const hasImage = parsed.some(p => p.type === 'image')
  const hasLink = parsed.some(p => p.type === 'link')

  if (hasImage) return <ImageIcon className="h-3.5 w-3.5 text-purple-600" />
  if (hasLink) return <ExternalLink className="h-3.5 w-3.5 text-purple-600" />
  return <FileText className="h-3.5 w-3.5 text-purple-600" />
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Enhanced tool fallback for connector (MCP) tools.
 * Shows connector branding, loading states, and formatted results.
 *
 * Falls through to the generic ToolFallback for non-connector tools.
 */
export const ConnectorToolFallback: ToolCallMessagePartComponent = (props) => {
  const { toolName, argsText, result } = props
  const [isExpanded, setIsExpanded] = useState(false)
  const connectorCtx = useConnectorTools()

  const connectorInfo = connectorCtx?.getConnectorInfo(toolName)

  // Always compute memos (hooks must not be conditional)
  const displayName = formatToolName(toolName)
  const argsSummary = useMemo(() => summarizeArgs(argsText), [argsText])
  const parsedResult = useMemo(() => parseResult(result), [result])
  const isLoading = result === undefined
  const isError = parsedResult.some(p => p.type === 'error')

  // Not a connector tool — render generic fallback
  if (!connectorInfo) {
    return <GenericToolFallback {...props} />
  }

  return (
    <div className="mb-4 w-full rounded-lg border border-purple-200 bg-purple-50/30 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3">
        {/* Connector icon */}
        <ConnectorIcon info={connectorInfo} />

        {/* Tool info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-purple-900 truncate">
              {displayName}
            </span>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-purple-300 text-purple-700">
              {connectorInfo.serverName}
            </Badge>
          </div>
          {!isExpanded && !isLoading && (
            <div className="text-xs text-purple-700/70 truncate mt-0.5">
              {argsSummary}
            </div>
          )}
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-2">
          {isLoading ? (
            <div className="flex items-center gap-1.5">
              <Loader2 className="h-4 w-4 text-purple-600 animate-spin" />
              <span className="text-xs text-purple-600 animate-pulse">Running...</span>
            </div>
          ) : isError ? (
            <AlertCircle className="h-4 w-4 text-red-500" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          )}

          {/* Expand/collapse */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            className="h-7 w-7 p-0 text-purple-700 hover:text-purple-900 hover:bg-purple-100"
          >
            {isExpanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-purple-200 px-4 py-3 space-y-3">
          {/* Arguments */}
          <div>
            <div className="text-xs font-semibold text-purple-900 mb-1">Arguments</div>
            <pre className="text-xs bg-purple-50 p-2 rounded overflow-x-auto text-purple-800 whitespace-pre-wrap">
              {argsText}
            </pre>
          </div>

          {/* Result */}
          {result !== undefined && (
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <ResultTypeIcon parsed={parsedResult} />
                <span className="text-xs font-semibold text-purple-900">Result</span>
              </div>
              <ResultRenderer parsed={parsedResult} />
            </div>
          )}
        </div>
      )}

      {/* Compact result preview (when collapsed and has result) */}
      {!isExpanded && !isLoading && parsedResult.length > 0 && !isError && (
        <div className="border-t border-purple-100 px-4 py-2">
          <div className="text-xs text-purple-700 truncate">
            {parsedResult[0]?.type === 'text' && parsedResult[0].text
              ? (parsedResult[0].text.length > 100
                ? `${parsedResult[0].text.substring(0, 97)}...`
                : parsedResult[0].text)
              : parsedResult[0]?.type === 'link'
                ? parsedResult[0].url
                : parsedResult[0]?.type === 'image'
                  ? 'Image result'
                  : 'Result available'}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Generic fallback (for non-connector tools)
// ============================================================================

/**
 * Generic tool fallback — mirrors the original ToolFallback from
 * components/assistant-ui/tool-fallback.tsx but integrated here
 * to keep the connector detection logic in one place.
 */
const GenericToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(true)
  return (
    <div className="mb-4 flex w-full flex-col gap-3 rounded-lg border py-3">
      <div className="flex items-center gap-2 px-4">
        <CheckCircle2 className="size-4" />
        <p className="flex-grow">
          Used tool: <b>{toolName}</b>
        </p>
        <Button onClick={() => setIsCollapsed(!isCollapsed)}>
          {isCollapsed ? <ChevronUp /> : <ChevronDown />}
        </Button>
      </div>
      {!isCollapsed && (
        <div className="flex flex-col gap-2 border-t pt-2">
          <div className="px-4">
            <pre className="whitespace-pre-wrap">{argsText}</pre>
          </div>
          {result !== undefined && (
            <div className="border-t border-dashed px-4 pt-2">
              <p className="font-semibold">Result:</p>
              <pre className="whitespace-pre-wrap">
                {typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Reconnect Prompt Component
// ============================================================================

interface ConnectorReconnectPromptProps {
  serverIds: string[]
  onReconnect: (serverId: string) => void
}

/**
 * Inline prompt shown when connector auth has expired.
 * Rendered in the message stream when X-Connector-Reconnect header is received.
 */
export function ConnectorReconnectPrompt({ serverIds, onReconnect }: ConnectorReconnectPromptProps) {
  const connectorCtx = useConnectorTools()

  if (serverIds.length === 0) return null

  // Look up server names from the tool map
  const serverNames = serverIds.map(id => {
    // Find any tool that belongs to this server
    if (connectorCtx) {
      const entry = Object.values(connectorCtx.toolMap).find(info => info.serverId === id)
      if (entry) return { id, name: entry.serverName }
    }
    return { id, name: 'Connector' }
  })

  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <div className="text-sm font-medium text-amber-900 mb-1">
            Connection expired
          </div>
          <div className="text-sm text-amber-800 mb-3">
            {serverNames.length === 1
              ? `Your ${serverNames[0]?.name} connection has expired.`
              : `${serverNames.length} connector connections have expired.`}
          </div>
          <div className="flex flex-wrap gap-2">
            {serverNames.map(({ id, name }) => (
              <Button
                key={id}
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 border-amber-300 text-amber-800 hover:bg-amber-100"
                onClick={() => onReconnect(id)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reconnect {name}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
