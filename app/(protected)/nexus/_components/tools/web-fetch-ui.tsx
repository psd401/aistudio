'use client'

import { useMemo } from 'react'
import { makeAssistantToolUI, type ToolCallMessagePartStatus } from '@assistant-ui/react'
import { Badge } from '@/components/ui/badge'
import { Link2 } from 'lucide-react'
import { ToolArgsRecoveryBoundary } from '@/components/assistant-ui/tool-args-recovery-boundary'
import type { WebFetchToolArgs, WebFetchToolResult } from '@/lib/tools/web-fetch-tool'

/**
 * Tool UI for the universal `web_fetch` tool (Issue #1696).
 *
 * Shows which page the assistant opened rather than dumping the raw tool JSON
 * through `ToolFallback`, so a user who pasted a link can see it was actually
 * read -- and, when it was not, why.
 */

/**
 * Best-effort display label for the fetched page.
 *
 * A completed result's `url` wins: it is the URL the page actually came from,
 * after redirects, and may be on a different host than the one requested.
 * Before the result exists, use `args`, which is empty while the call is still
 * streaming, then the partial `argsText`.
 */
function extractUrl(
  args: WebFetchToolArgs | undefined,
  argsText: string | undefined,
  result: WebFetchToolResult | undefined
): string {
  if (result?.url) return result.url
  if (args?.url) return args.url
  if (argsText) {
    try {
      const parsed: unknown = JSON.parse(argsText)
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { url?: unknown }).url === 'string'
      ) {
        return (parsed as { url: string }).url
      }
    } catch {
      // Partial JSON while streaming -- fall through to the result.
    }
  }
  return ''
}

/** Show the host when the URL parses, so the card stays readable for long URLs. */
function displayLabel(url: string): string {
  if (!url) return 'a web page'
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/**
 * First line of the failure text, which `fetchWebPageText` writes as a
 * human-readable reason (e.g. `Fetch failed: HTTP 404 Not Found`). The rest is
 * for the model, not the card.
 */
function failureReason(result: WebFetchToolResult | undefined): string {
  const first = result?.content?.split('\n', 1)[0]?.trim()
  return first || 'The page could not be read.'
}

function WebFetchLoading({ url }: { url: string }) {
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-blue-600 animate-pulse flex-shrink-0" />
        <span className="text-sm text-blue-900 truncate">
          <span className="font-medium">Reading:</span> {displayLabel(url)}
        </span>
      </div>
    </div>
  )
}

function WebFetchError({ url, reason }: { url: string; reason: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50/50 p-3">
      <div className="flex items-start gap-2">
        <Link2 className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-red-900">
            Couldn&apos;t read {displayLabel(url)}
          </div>
          <div className="text-xs text-red-700 break-words">{reason}</div>
        </div>
      </div>
    </div>
  )
}

function WebFetchSuccess({ url }: { url: string }) {
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <Link2 className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-blue-900">
              Read {displayLabel(url)}
            </div>
            {url && (
              <div className="text-xs text-blue-700 break-all">{url}</div>
            )}
          </div>
        </div>
        <Badge variant="secondary" className="text-xs flex-shrink-0">
          ✓ Complete
        </Badge>
      </div>
    </div>
  )
}

const WebFetchRenderer = ({
  args,
  result,
  status,
  argsText,
}: {
  args: WebFetchToolArgs
  result?: WebFetchToolResult
  status: ToolCallMessagePartStatus
  argsText: string
}) => {
  const url = useMemo(
    () => extractUrl(args, argsText, result),
    [args, argsText, result]
  )

  if (status.type === 'running' || status.type === 'requires-action') {
    return <WebFetchLoading url={url} />
  }

  // The tool never throws: a blocked host, a 404 or a timeout comes back as a
  // normal result with `ok: false`, so check the payload as well as the status.
  if (
    (status.type === 'incomplete' && status.reason === 'error') ||
    result?.ok === false
  ) {
    return <WebFetchError url={url} reason={failureReason(result)} />
  }

  return <WebFetchSuccess url={url} />
}

export const WebFetchUI = makeAssistantToolUI<WebFetchToolArgs, WebFetchToolResult>({
  toolName: 'web_fetch',
  render: (props) => (
    <ToolArgsRecoveryBoundary toolName="web_fetch">
      <WebFetchRenderer {...props} />
    </ToolArgsRecoveryBoundary>
  ),
})
