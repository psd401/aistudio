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
 * Renders export URL markers as styled download links.
 * Presigned URLs expire after 5 minutes — this is shown to the user.
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
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
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
