"use client"

import { Download } from "lucide-react"

/**
 * Regex to match PSD Data MCP export URL markers.
 * Format: [EXPORT_URL: <url> | rows: <count>]
 */
// Only match HTTPS — presigned S3 URLs are always HTTPS.
// Rejecting http:// prevents accidental plaintext token exposure.
const EXPORT_URL_PATTERN = /\[EXPORT_URL:\s*(https:\/\/[^\s|]+)\s*\|\s*rows:\s*(\d+)\]/g

interface ExportLink {
  url: string
  rows: number
}

/**
 * Parses export URL markers from text and returns the links found.
 */
export function parseExportUrls(text: string): ExportLink[] {
  const links: ExportLink[] = []
  for (const match of text.matchAll(EXPORT_URL_PATTERN)) {
    links.push({ url: match[1], rows: Number.parseInt(match[2], 10) })
  }
  return links
}

/**
 * Replaces export URL markers with placeholder text for LLM context.
 * Used server-side to strip presigned URLs from the model's context.
 */
export function stripExportUrls(text: string): string {
  return text.replace(
    EXPORT_URL_PATTERN,
    (_match, _url: string, rows: string) =>
      `[Export link provided to user (${rows} rows)]`
  )
}

/**
 * Builds the proxied download URL for an export link.
 *
 * Presigned S3 URLs signed with STS session credentials embed an
 * X-Amz-Security-Token that some browsers and network proxies mangle,
 * causing intermittent InvalidToken errors when clicked directly (the same
 * failure mode documented for psd-image-gen and fixed in PR #934).
 *
 * Routing through /api/export-download lets the Next.js server fetch the
 * file from S3 — where there are no CORS restrictions and no STS token in
 * the browser — and stream it to the user.
 */
function proxyDownloadUrl(presignedUrl: string): string {
  return `/api/export-download?url=${encodeURIComponent(presignedUrl)}`
}

/**
 * Renders export URL markers as styled download links.
 * Downloads are routed through /api/export-download to avoid browser-side
 * CORS and STS token issues with presigned S3 URLs.
 *
 * Accepts pre-parsed links to avoid redundant parsing when the caller
 * has already called parseExportUrls().
 */
export function ExportUrlLinks({ links }: { links: ExportLink[] }) {
  if (links.length === 0) return null

  return (
    <div className="my-2 space-y-2">
      {links.map((link) => (
        <a
          key={link.url}
          href={proxyDownloadUrl(link.url)}
          download
          className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-primary hover:bg-muted transition-colors"
        >
          <Download className="h-4 w-4 shrink-0" />
          <span>Download export ({link.rows.toLocaleString()} rows)</span>
          <span className="ml-auto text-xs text-muted-foreground">
            Link expires in 5 min
          </span>
        </a>
      ))}
    </div>
  )
}
