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
  // Require .amazonaws.com with a leading dot to reject attacker-amazonaws.com.
  // String-based checks avoid ReDoS vulnerabilities from complex regex quantifiers.
  const host = parsed.hostname
  if (!host.endsWith('.amazonaws.com')) return false
  return host.split('.').includes('s3')
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
  const userId = session.sub

  const url = req.nextUrl.searchParams.get('url')
  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 })
  }

  if (!isAllowedS3Url(url)) {
    log.warn('Rejected non-S3 export URL', { userId })
    return NextResponse.json({ error: 'Invalid export URL' }, { status: 400 })
  }

  try {
    const upstream = await fetch(url, {
      redirect: 'error',
      // Inner 30s timeout guards S3 response start; outer maxDuration=120 covers total stream time.
      signal: AbortSignal.timeout(30_000),
    }) // codeql[js/server-side-request-forgery] URL validated to AWS S3 hostname by isAllowedS3Url; redirect:error blocks SSRF via open redirects

    if (!upstream.ok) {
      if (upstream.status === 403 || upstream.status === 404) {
        log.warn('Presigned URL expired or invalid', { upstreamStatus: upstream.status, userId })
        timer({ status: 'expired' })
        return NextResponse.json(
          {
            error:
              'Export link has expired — please re-run the query to generate a new download link.',
          },
          { status: 410 }
        )
      }
      log.error('Upstream S3 error', { upstreamStatus: upstream.status, userId })
      timer({ status: 'error' })
      return NextResponse.json({ error: 'Failed to fetch export file' }, { status: 502 })
    }

    // Reject oversized exports before streaming to avoid exhausting ECS task memory.
    const contentLength = upstream.headers.get('Content-Length')
    if (contentLength && Number(contentLength) > MAX_EXPORT_BYTES) {
      log.warn('Export too large to proxy', { bytes: contentLength, userId })
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
    log.info('Export proxied successfully', { filename, contentLength, userId })

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
      userId,
    })
    return NextResponse.json({ error: 'Failed to fetch export file' }, { status: 502 })
  }
}
