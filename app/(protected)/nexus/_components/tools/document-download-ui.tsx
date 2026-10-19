'use client'

import { makeAssistantToolUI, type ToolCallMessagePartStatus } from '@assistant-ui/react'
import { Download, FileSpreadsheet, FileText, Presentation } from 'lucide-react'
import { ToolArgsRecoveryBoundary } from '@/components/assistant-ui/tool-args-recovery-boundary'
import {
  DOCUMENT_CREATE_TOOL_NAME,
  NEXUS_DOCUMENT_DOWNLOAD_PREFIX,
  type DocumentCreateToolArgs,
  type DocumentCreateToolResult,
} from '@/lib/tools/document-create-contract'

/**
 * Download card for the Nexus `generate_document` tool (Issue #1898).
 *
 * This card IS the deliverable — the whole point of the issue is that the user
 * gets a file instead of text to copy — so it renders directly rather than
 * inside the collapsible "Tool Actions" group (see `DIRECT_RENDER_TOOLS` in
 * `tool-group.tsx`).
 *
 * `result.downloadUrl` is an app-relative path to `/api/nexus/documents/...`,
 * which re-authorizes the caller on every request. That is why the link keeps
 * working after a page reload: nothing here depends on a presigned URL that
 * would have expired, and the persisted tool result carries no credential.
 */

/** Labels shown on the card for each format. */
const FORMAT_LABEL: Record<string, string> = {
  pdf: 'PDF',
  docx: 'Word document',
  xlsx: 'Excel spreadsheet',
  pptx: 'PowerPoint deck',
  md: 'Markdown',
  html: 'HTML',
  txt: 'Text file',
  csv: 'CSV',
}

function formatLabel(format: string | undefined): string {
  if (!format) return 'File'
  return FORMAT_LABEL[format] ?? format.toUpperCase()
}

/**
 * Format glyph. Written as a component that renders a FIXED element per branch
 * rather than returning the icon component from a lookup: a component value
 * produced during render is a new component type each pass, which resets its
 * state (and is an eslint `react-hooks/static-components` error).
 */
function FormatIcon({
  format,
  className,
}: {
  format: string | undefined
  className: string
}) {
  if (format === 'xlsx' || format === 'csv') {
    return <FileSpreadsheet className={className} />
  }
  if (format === 'pptx') return <Presentation className={className} />
  return <FileText className={className} />
}

/**
 * Human-readable size. Uses 1024-based units with the matching KB/MB labels the
 * rest of the product uses, and never shows "0 KB" for a small-but-real file.
 */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Only an app-relative path to our own download route is accepted as an href.
 * The tool result is persisted and replayed on reload, so treating it as a
 * trusted URL source would turn a corrupted or tampered message part into an
 * off-site (or `javascript:`) link rendered inside the user's conversation.
 */
export function safeDownloadHref(downloadUrl: string | undefined): string | null {
  if (typeof downloadUrl !== 'string') return null
  if (!downloadUrl.startsWith(NEXUS_DOCUMENT_DOWNLOAD_PREFIX)) return null
  // A second slash-pair or a backslash could re-point the browser at another
  // origin ("//evil.example") even though the string starts with a slash.
  if (downloadUrl.includes('//') || downloadUrl.includes('\\')) return null
  return downloadUrl
}

function DocumentPending({ format }: { format: string | undefined }) {
  return (
    <div className="my-2 rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex items-center gap-2">
        <FormatIcon
          format={format}
          className="h-4 w-4 shrink-0 animate-pulse text-muted-foreground"
        />
        <span className="text-sm text-muted-foreground">
          Creating your {formatLabel(format).toLowerCase()}…
        </span>
      </div>
    </div>
  )
}

function DocumentFailed({ reason }: { reason: string }) {
  return (
    <div className="my-2 rounded-lg border border-red-200 bg-red-50/50 p-3">
      <div className="flex items-start gap-2">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-red-900">
            Couldn&apos;t create the file
          </div>
          <div className="break-words text-xs text-red-700">{reason}</div>
        </div>
      </div>
    </div>
  )
}

export function DocumentDownloadCard({
  href,
  filename,
  format,
  bytes,
}: {
  href: string
  filename: string
  format: string | undefined
  bytes: number | undefined
}) {
  const size = formatBytes(bytes)
  return (
    <a
      href={href}
      download={filename}
      className="my-2 flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-3 py-2 transition-colors hover:bg-muted"
      data-testid="nexus-document-download"
      data-filename={filename}
    >
      <FormatIcon format={format} className="h-5 w-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {filename}
        </div>
        <div
          className="text-xs text-muted-foreground"
          data-testid="nexus-document-meta"
        >
          {formatLabel(format)}
          {size ? ` · ${size}` : ''}
        </div>
      </div>
      <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
    </a>
  )
}

/** What the card should show for one `generate_document` call. */
type DocumentCardState =
  | { kind: 'pending' }
  | { kind: 'failed'; reason: string }
  | { kind: 'ready'; href: string; filename: string }

/**
 * Decide the card's state from the part status and the tool result.
 *
 * The tool returns failures as `{ ok: false, error }` rather than throwing, so
 * the payload is inspected alongside the status. A result that claims success
 * but carries no usable filename or download path is treated as a failure too:
 * rendering a dead link would be worse than saying the link is gone. Returning
 * a discriminated state keeps the href/filename non-optional at the call site,
 * so the renderer needs no casts.
 *
 * Exported for unit testing.
 */
export function resolveDocumentCardState(
  status: ToolCallMessagePartStatus,
  result: DocumentCreateToolResult | undefined
): DocumentCardState {
  if (status.type === 'running' || status.type === 'requires-action') {
    return { kind: 'pending' }
  }
  const errored = status.type === 'incomplete' && status.reason === 'error'
  if (errored || result?.ok === false) {
    return {
      kind: 'failed',
      reason: result?.error || 'The file could not be created.',
    }
  }
  const href = safeDownloadHref(result?.downloadUrl)
  if (!href || !result?.filename) {
    return {
      kind: 'failed',
      reason: 'The download link for this file is no longer valid.',
    }
  }
  return { kind: 'ready', href, filename: result.filename }
}

const DocumentDownloadRenderer = ({
  args,
  result,
  status,
}: {
  args: DocumentCreateToolArgs
  result?: DocumentCreateToolResult
  status: ToolCallMessagePartStatus
}) => {
  const format = result?.format ?? args?.format
  const state = resolveDocumentCardState(status, result)

  if (state.kind === 'pending') return <DocumentPending format={format} />
  if (state.kind === 'failed') return <DocumentFailed reason={state.reason} />

  return (
    <DocumentDownloadCard
      href={state.href}
      filename={state.filename}
      format={format}
      bytes={result?.bytes}
    />
  )
}

export const DocumentDownloadUI = makeAssistantToolUI<
  DocumentCreateToolArgs,
  DocumentCreateToolResult
>({
  toolName: DOCUMENT_CREATE_TOOL_NAME,
  render: (props) => (
    <ToolArgsRecoveryBoundary toolName={DOCUMENT_CREATE_TOOL_NAME}>
      <DocumentDownloadRenderer {...props} />
    </ToolArgsRecoveryBoundary>
  ),
})
