'use client'

import { useState, useMemo, useCallback } from 'react'
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
  X,
} from 'lucide-react'
import { useConnectorToolsOptional, type ConnectorServerInfo } from './connector-tool-context'
import type { McpToolResult } from '@/lib/mcp/types'
import { ToolFallback } from '@/components/assistant-ui/tool-fallback'

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
 * NOTE: argsText is model-generated content (from the AI stream), not user input.
 * Rendered in JSX text nodes / <pre> which auto-escape HTML — do not use dangerouslySetInnerHTML.
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

/** Allowlist of safe image MIME types for data URI construction.
 * image/svg+xml is intentionally included: when rendered via <img> (not <object>/<embed>),
 * SVG scripts are sandboxed by browsers and do not execute.
 * WARNING: This allowlist is only safe for <img src> rendering. If these MIME types are ever
 * used in CSS backgrounds, <object>, or <embed> tags, SVG script execution is possible. */
const SAFE_IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp',
])

/** Type guard for plain objects — excludes Date, RegExp, Array, and other built-ins */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Maximum content items to render from a single tool result */
const MAX_CONTENT_ITEMS = 50

/** Maximum base64 string length for image rendering (~5MB decoded) */
const MAX_IMAGE_BASE64_LENGTH = 5 * 1024 * 1024

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

  // Non-MCP error objects (e.g. { isError: true, error: 'message' }) — surfaced by assistant-ui
  if (isPlainObject(result)) {
    if (result.isError === true && !Object.hasOwn(result, 'content')) {
      const errorText = typeof result.error === 'string' ? result.error
        : typeof result.message === 'string' ? result.message
        : 'Tool execution failed'
      return [{ type: 'error', text: errorText }]
    }
  }

  // MCP tool results follow the McpToolResult format: { content: McpContentItem[] }
  // Double cast needed: isPlainObject narrows to Record<string, unknown> which doesn't
  // structurally overlap McpToolResult. The Object.hasOwn guard validates the shape.
  if (isPlainObject(result) && Object.hasOwn(result, 'content')) {
    const mcpResult = result as unknown as McpToolResult

    if (mcpResult.isError) {
      const errorText = mcpResult.content
        ?.filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n') || 'Tool execution failed'
      return [{ type: 'error', text: errorText }]
    }

    return (mcpResult.content || []).slice(0, MAX_CONTENT_ITEMS).map(item => {
      if (item.type === 'image') {
        return { type: 'image' as const, url: item.data, mimeType: item.mimeType }
      }
      if (item.type === 'resource') {
        if (!item.text) {
          return { type: 'text' as const, text: '(Binary resource)' }
        }
        // MCP resource items: item.text holds the resource content body.
        // If it looks like an HTTPS URL, render as a clickable link.
        if (/^https:\/\//.test(item.text)) {
          return { type: 'link' as const, url: item.text, mimeType: item.mimeType }
        }
        // Skip URI-like strings (file://, custom schemes) that aren't renderable content
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(item.text)) {
          return { type: 'text' as const, text: '(Resource not available for display)' }
        }
        // Non-URL content falls through to text rendering below
      }
      return { type: 'text' as const, text: item.text || '' }
    })
  }

  // String result
  if (typeof result === 'string') {
    // Restrict to https:// only — connector output is untrusted
    if (/^https:\/\//.test(result)) {
      return [{ type: 'link', url: result }]
    }
    return [{ type: 'text', text: result }]
  }

  // Fallback: JSON
  return [{ type: 'json', text: JSON.stringify(result, null, 2) }]
}

/** Validate that an icon URL is safe to render (https only, no data: or javascript:).
 * Note: iconUrl comes from admin-configured connector registration data, not user input.
 * Rendered in <img src> which does not execute scripts. */
function isSafeIconUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function ConnectorIcon({ info, size = 16 }: { info: ConnectorServerInfo; size?: number }) {
  if (info.iconUrl && isSafeIconUrl(info.iconUrl)) {
    return (
      <img
        src={info.iconUrl}
        alt={info.serverName}
        width={size}
        height={size}
        className="rounded-sm"
        referrerPolicy="no-referrer"
        crossOrigin="anonymous"
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
  // Guard against oversized payloads that could freeze the browser
  if (url.length > MAX_IMAGE_BASE64_LENGTH) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5">
        <span className="text-sm text-amber-800">Image too large to display</span>
      </div>
    )
  }

  const safeMime = mimeType && SAFE_IMAGE_MIME_TYPES.has(mimeType) ? mimeType : 'image/png'

  // Validate pre-formed data URIs against the same MIME allowlist
  if (url.startsWith('data:')) {
    const semiIdx = url.indexOf(';')
    if (semiIdx === -1) {
      return (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5">
          <span className="text-sm text-amber-800">Unsupported image format</span>
        </div>
      )
    }
    const declaredMime = url.slice(5, semiIdx)
    if (!SAFE_IMAGE_MIME_TYPES.has(declaredMime)) {
      return (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5">
          <span className="text-sm text-amber-800">Unsupported image format</span>
        </div>
      )
    }
  }

  const src = url.startsWith('data:') ? url : `data:${safeMime};base64,${url}`
  return (
    <div className="mt-2">
      <img
        src={src}
        alt="Connector result"
        className="max-w-xs rounded-lg border shadow-sm"
        referrerPolicy="no-referrer"
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
        const key = `${item.type}-${i}`
        switch (item.type) {
          case 'text': return <TextResult key={key} text={item.text || ''} />
          case 'image': return <ImageResult key={key} url={item.url || ''} mimeType={item.mimeType} />
          case 'link': return <LinkResult key={key} url={item.url || ''} />
          case 'error': return <ErrorResult key={key} text={item.text || 'Unknown error'} />
          case 'json': return <JsonResult key={key} text={item.text || '{}'} />
          default: return null
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

/** Get a compact preview string for the first result item */
function getPreviewText(parsed: ParsedResult[]): string {
  const first = parsed[0]
  if (!first) return 'Result available'
  if (first.type === 'text' && first.text) {
    return first.text.length > 100 ? `${first.text.substring(0, 97)}...` : first.text
  }
  if (first.type === 'link') return first.url || 'Link'
  if (first.type === 'image') return 'Image result'
  return 'Result available'
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
  const connectorCtx = useConnectorToolsOptional()
  const connectorInfo = connectorCtx?.getConnectorInfo(toolName)

  // Not a connector tool — render the standard generic fallback.
  // Early return avoids computing displayName, argsSummary, parsedResult for non-connector tools.
  if (!connectorInfo) {
    return <ToolFallback {...props} />
  }

  return <ConnectorToolCard toolName={toolName} argsText={argsText} result={result} connectorInfo={connectorInfo} />
}

/** Inner component for connector tools — avoids conditional hooks in the parent. */
function ConnectorToolCard({ toolName, argsText, result, connectorInfo }: {
  toolName: string
  argsText: string
  result: unknown
  connectorInfo: ConnectorServerInfo
}) {
  const displayName = formatToolName(toolName)
  const argsSummary = useMemo(() => summarizeArgs(argsText), [argsText])
  const parsedResult = useMemo(() => parseResult(result), [result])
  const isLoading = result === undefined
  const isError = parsedResult.some(p => p.type === 'error')

  // null = no user interaction yet; boolean = user has explicitly toggled.
  // toggleExpanded closes over isError so the callback recreates when error state changes.
  // This is intentional: the toggle needs to know the currently displayed state to invert it.
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null)
  const toggleExpanded = useCallback(
    () => setManualExpanded(prev => !(prev !== null ? prev : isError)),
    [isError]
  )

  // Auto-expand on error unless user has explicitly toggled.
  // Derived state avoids setState-in-useEffect cascading render pattern.
  const isExpanded = manualExpanded !== null ? manualExpanded : isError

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

        {/* Status indicator — aria-live announces tool completion/failure to screen readers */}
        <div className="flex items-center gap-2" aria-live="polite" aria-atomic="true">
          {isLoading ? (
            <div className="flex items-center gap-1.5">
              <Loader2 className="h-4 w-4 text-purple-600 animate-spin" aria-hidden="true" />
              <span className="text-xs text-purple-600 animate-pulse">Running...</span>
            </div>
          ) : isError ? (
            <AlertCircle className="h-4 w-4 text-red-500" aria-label="Tool failed" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-green-600" aria-label="Tool completed" />
          )}

          {/* Expand/collapse — min 44px touch target per WCAG 2.5.5 */}
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleExpanded}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Hide tool details' : 'Show tool details'}
            className="h-9 w-9 p-0 text-purple-700 hover:text-purple-900 hover:bg-purple-100"
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
            <pre className="text-xs bg-purple-50 p-2 rounded overflow-x-auto overflow-y-auto max-h-48 text-purple-800 whitespace-pre-wrap">
              {argsText.length > 10_000 ? `${argsText.slice(0, 10_000)}…` : argsText}
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
            {getPreviewText(parsedResult)}
          </div>
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
}

/**
 * Inline prompt shown when connector auth has expired.
 * Rendered in the message stream when X-Connector-Reconnect header is received.
 */
export function ConnectorReconnectPrompt({ serverIds }: ConnectorReconnectPromptProps) {
  const connectorCtx = useConnectorToolsOptional()

  // O(1) server name lookup via reverse index
  const serverNames = useMemo(() => {
    return serverIds.map(id => {
      const info = connectorCtx?.serverMap[id]
      return { id, name: info?.serverName ?? 'Connector' }
    })
  }, [serverIds, connectorCtx?.serverMap])

  const handleDismiss = useCallback(() => {
    if (!connectorCtx) return
    for (const id of serverIds) {
      connectorCtx.removeFailedServerId(id)
    }
  }, [connectorCtx, serverIds])

  if (serverIds.length === 0) return null

  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <div className="text-sm font-medium text-amber-900 mb-1">
            Connection expired
          </div>
          <div className="text-sm text-amber-800">
            {serverNames.length === 1
              ? `Your ${serverNames[0]?.name} connection has expired.`
              : `Your ${serverNames.map(s => s.name).join(', ')} connections have expired.`}
            {' '}Use the <strong>Connect</strong> menu in the composer to re-authenticate.
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          aria-label="Dismiss connection prompt"
          className="h-8 w-8 p-0 text-amber-600 hover:text-amber-800 hover:bg-amber-100 flex-shrink-0"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
