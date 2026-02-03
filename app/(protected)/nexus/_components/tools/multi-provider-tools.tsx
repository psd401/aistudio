'use client'

import { useMemo } from 'react'
import { makeAssistantToolUI, type ToolCallMessagePartStatus } from '@assistant-ui/react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Globe, Clock, Code2, Terminal, ExternalLink } from 'lucide-react'
import { ChartVisualizationUI } from './chart-visualization-ui'

/**
 * Multi-Provider Tool UIs
 *
 * Registers tool UI components for provider-specific tools.
 * Search tools will be displayed in a ToolGroup when multiple searches occur.
 */

// ============================================================================
// Web Search Tool UI (OpenAI & Google)
// ============================================================================

interface WebSearchArgs {
  query: string
  maxResults?: number
}

interface WebSearchResult {
  query?: string
  results?: Array<{
    title: string
    url: string
    snippet: string
    source: string
    publishedDate?: string
  }>
  searchTime?: number
  totalResults?: number
}

// Helper to extract query from various sources
function extractQuery(
  args: WebSearchArgs | undefined,
  argsText: string | undefined,
  result: WebSearchResult | undefined
): string {
  // Try args first
  if (args?.query) return args.query

  // Try parsing argsText as JSON
  if (argsText) {
    try {
      const parsed = JSON.parse(argsText)
      if (parsed?.query) return parsed.query
    } catch {
      // If parsing fails, argsText might be the query itself
      if (argsText.trim() && !argsText.startsWith('{')) {
        return argsText
      }
    }
  }

  // Try result as last resort
  if (result?.query) return result.query

  return 'Unknown query'
}

// Web search loading state
function WebSearchLoading({ query }: { query: string }) {
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-1">
          <Globe className="h-4 w-4 text-blue-600 animate-pulse flex-shrink-0" />
          <span className="text-sm text-blue-900 truncate">
            <span className="font-medium">Searching:</span> {query}
          </span>
        </div>
        <div className="flex items-center gap-1 text-xs text-blue-600">
          <div className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-pulse" />
          <span>In progress</span>
        </div>
      </div>
    </div>
  )
}

// Web search error state
function WebSearchError({ query }: { query: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50/50 p-3">
      <div className="flex items-center gap-2">
        <Globe className="h-4 w-4 text-red-600" />
        <div className="flex-1">
          <div className="text-sm font-medium text-red-900">Search failed</div>
          <div className="text-xs text-red-700 break-words">{query}</div>
        </div>
      </div>
    </div>
  )
}

// Web search success state
function WebSearchSuccess({
  query,
  result,
}: {
  query: string
  result?: WebSearchResult
}) {
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <Globe className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-blue-900 mb-1 break-words">{query}</div>
            <div className="flex items-center gap-3 text-xs text-blue-700">
              {result?.totalResults !== undefined && (
                <span>{result.totalResults.toLocaleString()} results</span>
              )}
              {result?.searchTime !== undefined && (
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  <span>{result.searchTime}ms</span>
                </div>
              )}
            </div>
          </div>
        </div>
        <Badge variant="secondary" className="text-xs flex-shrink-0">
          ✓ Complete
        </Badge>
      </div>
    </div>
  )
}

const WebSearchRenderer = ({
  args,
  result,
  status,
  argsText,
}: {
  args: WebSearchArgs
  result?: WebSearchResult
  status: ToolCallMessagePartStatus
  argsText: string
}) => {
  const query = useMemo(
    () => extractQuery(args, argsText, result),
    [args, argsText, result]
  )

  if (status.type === 'running' || status.type === 'requires-action') {
    return <WebSearchLoading query={query} />
  }

  if (status.type === 'incomplete' && status.reason === 'error') {
    return <WebSearchError query={query} />
  }

  return <WebSearchSuccess query={query} result={result} />
}

// OpenAI web search tool
export const OpenAIWebSearchUI = makeAssistantToolUI<WebSearchArgs, WebSearchResult>({
  toolName: 'web_search_preview',
  render: WebSearchRenderer,
})

// Google search tool
export const GoogleSearchUI = makeAssistantToolUI<WebSearchArgs, WebSearchResult>({
  toolName: 'google_search',
  render: WebSearchRenderer,
})

// ============================================================================
// Code Interpreter Tool UI (OpenAI)
// ============================================================================

interface CodeInterpreterArgs {
  code?: string
  language?: string
  files?: string[]
}

interface CodeFile {
  name: string
  url: string
  type: string
}

interface CodeInterpreterResult {
  output?: string
  error?: string
  stdout?: string
  stderr?: string
  executionTime?: number
  files?: CodeFile[]
}

// Code interpreter loading state
function CodeInterpreterLoading({ code }: { code?: string }) {
  return (
    <Card className="border-green-200 bg-green-50/50">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-green-600 animate-pulse" />
          <CardTitle className="text-sm text-green-900">Executing code...</CardTitle>
        </div>
        {code && (
          <CardDescription className="text-xs font-mono text-green-800">
            {code.substring(0, 100)}
            {code.length > 100 && '...'}
          </CardDescription>
        )}
      </CardHeader>
    </Card>
  )
}

// Code interpreter error state
function CodeInterpreterError() {
  return (
    <Card className="border-red-200 bg-red-50/50">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-red-600" />
          <CardTitle className="text-sm text-red-900">Code Execution Failed</CardTitle>
        </div>
      </CardHeader>
    </Card>
  )
}

// Output block component
function OutputBlock({
  label,
  content,
  variant,
}: {
  label: string
  content: string
  variant: 'success' | 'error' | 'warning'
}) {
  const colors = {
    success: { label: 'text-green-900', bg: 'bg-green-100', text: 'text-green-900' },
    error: { label: 'text-red-900', bg: 'bg-red-100', text: 'text-red-900' },
    warning: { label: 'text-yellow-900', bg: 'bg-yellow-100', text: 'text-yellow-900' },
  }
  const c = colors[variant]

  return (
    <div>
      <div className={`text-xs font-semibold ${c.label} mb-1`}>{label}:</div>
      <pre className={`text-xs ${c.bg} p-2 rounded overflow-x-auto ${c.text}`}>{content}</pre>
    </div>
  )
}

// Generated files list
function GeneratedFiles({ files }: { files: CodeFile[] }) {
  return (
    <div>
      <div className="text-xs font-semibold text-green-900 mb-1">Generated Files:</div>
      <div className="space-y-1">
        {files.map((file, index) => (
          <a
            key={index}
            href={file.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs text-green-700 hover:text-green-900 hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            {file.name} ({file.type})
          </a>
        ))}
      </div>
    </div>
  )
}

// Code interpreter success state
function CodeInterpreterSuccess({ result }: { result?: CodeInterpreterResult }) {
  return (
    <Card className="border-green-200 bg-green-50/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-green-600" />
            <CardTitle className="text-sm text-green-900">Code Execution</CardTitle>
          </div>
          {result?.executionTime !== undefined && (
            <Badge variant="secondary" className="text-xs">
              {result.executionTime}ms
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {result?.stdout && <OutputBlock label="Output" content={result.stdout} variant="success" />}
        {result?.output && <OutputBlock label="Result" content={result.output} variant="success" />}
        {result?.error && <OutputBlock label="Error" content={result.error} variant="error" />}
        {result?.stderr && <OutputBlock label="stderr" content={result.stderr} variant="warning" />}
        {result?.files && result.files.length > 0 && <GeneratedFiles files={result.files} />}
      </CardContent>
    </Card>
  )
}

const CodeInterpreterRenderer = ({
  args,
  result,
  status,
}: {
  args: CodeInterpreterArgs
  result?: CodeInterpreterResult
  status: ToolCallMessagePartStatus
}) => {
  if (status.type === 'running') {
    return <CodeInterpreterLoading code={args.code} />
  }

  if (status.type === 'incomplete' && status.reason === 'error') {
    return <CodeInterpreterError />
  }

  return <CodeInterpreterSuccess result={result} />
}

export const CodeInterpreterUI = makeAssistantToolUI<CodeInterpreterArgs, CodeInterpreterResult>({
  toolName: 'code_interpreter',
  render: CodeInterpreterRenderer,
})

// ============================================================================
// Wrapper Component - Registers All Tool UIs
// ============================================================================

export function MultiProviderToolUIs() {
  return (
    <>
      {/* Web Search tools - will be grouped by ToolGroup when multiple searches occur */}
      <OpenAIWebSearchUI />
      <GoogleSearchUI />

      {/* Code Interpreter - shows execution results */}
      <CodeInterpreterUI />

      {/* Chart Visualization - renders interactive charts in chat */}
      <ChartVisualizationUI />
    </>
  )
}
