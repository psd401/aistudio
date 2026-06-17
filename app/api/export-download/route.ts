import { type NextRequest, NextResponse } from 'next/server'
import { getServerSession } from '@/lib/auth/server-session'
import { createLogger, generateRequestId, startTimer } from '@/lib/logger'

export const runtime = 'nodejs'
// Exports can be large CSVs; allow up to 2 minutes before ALB times out.
export const maxDuration = 120

// 50 MB hard cap — prevents a single large export from exhausting ECS task memory.
const MAX_EXPORT_BYTES = 50 * 1024 * 1024

/**
 * Validates that the URL is a legitimate AWS S3 presigned URL.
 *
 * Accepts virtual-hosted-style  (bucket.s3[.region].amazonaws.com)
 * and path-style               (s3[.region].amazonaws.com/bucket).
 * Rejects everything else to prevent the proxy being used for SSRF.
 */
function isAllowedS3Url(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  // hostname must be *.amazonaws.com and contain "s3" as a label
  return /^([a-z0-9][a-z0-9\-.]{0,61}\.)?s3(\.[a-z0-9-]+)*\.amazonaws\.com$/.test(
    parsed.hostname
  )
}

/**
 * GET /api/export-download?url=<encoded-presigned-s3-url>
 *
 * Proxies a psd-data-mcp CSV export through the Next.js server so the
 * browser never has to deal with presigned STS tokens or S3 CORS policies.
 *
 * Auth: session required.
 * URL validation: only AWS S3 hostnames are allowed (SSRF guard).
 */
export async function GET(req: NextRequest) {
  const requestId = generateRequestId()
  const timer = startTimer('exportDownload')
  const log = createLogger({ requestId, action: 'exportDownload' })

  const session = await getServerSession()
  if (!session?.sub) {
    log.warn('Unauthorized export-download request')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = req.nextUrl.searchParams.get('url')
  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 })
  }

  if (!isAllowedS3Url(url)) {
    log.warn('Rejected non-S3 export URL', { urlPrefix: url.slice(0, 80) })
    return NextResponse.json({ error: 'Invalid export URL' }, { status: 400 })
  }

  try {
    const upstream = await fetch(url)

    if (!upstream.ok) {
      if (upstream.status === 403 || upstream.status === 404) {
        log.warn('Presigned URL expired or invalid', { upstreamStatus: upstream.status })
        timer({ status: 'expired' })
        return NextResponse.json(
          {
            error:
              'Export link has expired. Presigned URLs are valid for 5 minutes — please re-run the query to get a new export link.',
          },
          { status: 410 }
        )
      }
      log.error('Upstream S3 error', { upstreamStatus: upstream.status })
      timer({ status: 'error' })
      return NextResponse.json({ error: 'Failed to fetch export file' }, { status: 502 })
    }

    // Reject oversized exports before streaming to avoid exhausting ECS task memory.
    const contentLength = upstream.headers.get('Content-Length')
    if (contentLength && Number(contentLength) > MAX_EXPORT_BYTES) {
      log.warn('Export too large to proxy', { bytes: contentLength })
      timer({ status: 'too-large' })
      return NextResponse.json(
        { error: `Export is too large to download via the browser (max ${MAX_EXPORT_BYTES / 1024 / 1024} MB). Contact support.` },
        { status: 413 }
      )
    }

    // Derive a sensible filename from the S3 object key.
    const s3Path = new URL(url).pathname
    const rawFilename = s3Path.split('/').pop() || 'export.csv'
    // Strip any query-string remnant and sanitize (allowlist: alphanumeric, dots, hyphens, underscores)
    const filename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'export.csv'

    timer({ status: 'success' })
    log.info('Export proxied successfully', { filename, contentLength })

    // Force text/csv regardless of what S3 reports — the upstream Content-Type
    // is attacker-influenced (object owner controls object metadata). Passthrough
    // would let an html/js payload be delivered with an executable MIME type.
    const headers: Record<string, string> = {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }
    if (contentLength) headers['Content-Length'] = contentLength

    return new NextResponse(upstream.body, { headers })
  } catch (err) {
    timer({ status: 'error' })
    log.error('Export download failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'Failed to fetch export file' }, { status: 502 })
  }
}
