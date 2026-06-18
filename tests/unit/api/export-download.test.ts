/**
 * @jest-environment node
 *
 * Must run in Node environment: the route uses AbortSignal.timeout() which is
 * a Node 17.3+ built-in and is not available in jsdom.
 */

jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  generateRequestId: jest.fn(() => 'test-request-id'),
  startTimer: jest.fn(() => jest.fn()),
}))

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server')
  return {
    ...actual,
    NextResponse: class NextResponse {
      body: unknown
      status: number
      headers: Headers

      constructor(body: unknown, init?: { headers?: Record<string, string>; status?: number }) {
        this.body = body
        this.status = init?.status ?? 200
        this.headers = new Headers(init?.headers)
      }

      async json() {
        return JSON.parse(this.body as string)
      }

      static json(data: unknown, init?: { status?: number }) {
        return new NextResponse(JSON.stringify(data), { status: init?.status ?? 200 })
      }
    },
  }
})

import { GET } from '@/app/api/export-download/route'
import { getServerSession } from '@/lib/auth/server-session'

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>

// NextRequest exposes `nextUrl` (a URL instance). Build a minimal mock that
// satisfies the route's usage: req.nextUrl.searchParams.get('url').
function makeRequest(exportUrl?: string) {
  const base = 'https://aistudio.psd401.ai'
  const path = exportUrl
    ? `/api/export-download?url=${encodeURIComponent(exportUrl)}`
    : '/api/export-download'
  return { nextUrl: new URL(`${base}${path}`) }
}

describe('GET /api/export-download', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn()
  })

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null)

    const res = await GET(makeRequest('https://bucket.s3.us-west-2.amazonaws.com/file.csv') as never)

    const body = await res.json()
    expect(res.status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 400 when url parameter is missing', async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: 'user-1', email: 'test@psd401.net' })

    const res = await GET(makeRequest() as never)

    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/missing url/i)
  })

  it('rejects non-S3 URLs (SSRF guard)', async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: 'user-1', email: 'test@psd401.net' })

    const res = await GET(makeRequest('https://evil.example.com/data.csv') as never)

    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/invalid export url/i)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('rejects attacker-amazonaws.com (substring bypass attempt)', async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: 'user-1', email: 'test@psd401.net' })

    const res = await GET(makeRequest('https://attacker-amazonaws.com/data.csv') as never)

    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/invalid export url/i)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('rejects http:// S3 URLs', async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: 'user-1', email: 'test@psd401.net' })

    const res = await GET(makeRequest('http://bucket.s3.amazonaws.com/file.csv') as never)

    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/invalid export url/i)
  })

  it('accepts virtual-hosted-style S3 URLs with region', async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: 'user-1', email: 'test@psd401.net' })
    // Use a plain object (not new Response()) to avoid undici ReadableStream /
    // TransformStream incompatibility in the Jest Node environment.
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/csv', 'Content-Length': '20' }),
      body: null,
    })

    const s3Url =
      'https://psd-data-exports.s3.us-west-2.amazonaws.com/exports/user/query.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256'
    const res = await GET(makeRequest(s3Url) as never)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment.*filename.*query\.csv/)
  })

  it('returns 410 when presigned URL has expired (S3 returns 403)', async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: 'user-1', email: 'test@psd401.net' })
    ;(global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response('<Error>AccessDenied</Error>', { status: 403 })
    )

    const s3Url = 'https://bucket.s3.us-west-2.amazonaws.com/exports/query.csv?X-Amz-Signature=abc'
    const res = await GET(makeRequest(s3Url) as never)

    const body = await res.json()
    expect(res.status).toBe(410)
    expect(body.error).toMatch(/expired/i)
  })

  it('streams CSV with correct headers on success', async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: 'user-1', email: 'test@psd401.net' })
    const csvLength = 'id,name\n1,Alice\n2,Bob'.length
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': String(csvLength) }),
      body: null,
    })

    const s3Url =
      'https://psd-data-exports.s3.amazonaws.com/exports/student-counts-2026.csv?X-Amz-Credential=xxx'
    const res = await GET(makeRequest(s3Url) as never)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="student-counts-2026.csv"'
    )
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('forces text/csv even when S3 returns a different Content-Type', async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: 'user-1', email: 'test@psd401.net' })
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      // S3 object metadata can be set by whoever uploaded the object
      headers: new Headers({ 'Content-Type': 'text/html', 'Content-Length': '21' }),
      body: null,
    })

    const s3Url = 'https://bucket.s3.amazonaws.com/exports/data.csv?X-Amz-Credential=xxx'
    const res = await GET(makeRequest(s3Url) as never)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('returns 413 when S3 Content-Length exceeds the 50 MB cap', async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: 'user-1', email: 'test@psd401.net' })
    const bigSize = 51 * 1024 * 1024 // 51 MB
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      // Explicit Headers object ensures Content-Length is accessible via .get()
      // (undici Response constructor may strip Content-Length in some Node versions)
      headers: new Headers({ 'Content-Type': 'text/csv', 'Content-Length': String(bigSize) }),
      body: null,
    })

    const s3Url = 'https://bucket.s3.amazonaws.com/exports/huge.csv?X-Amz-Credential=xxx'
    const res = await GET(makeRequest(s3Url) as never)

    const body = await res.json()
    expect(res.status).toBe(413)
    expect(body.error).toMatch(/too large/i)
  })

  it('returns 502 when upstream fetch throws a network error', async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: 'user-1', email: 'test@psd401.net' })
    ;(global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Failed to fetch'))

    const s3Url = 'https://bucket.s3.amazonaws.com/exports/data.csv?X-Amz-Credential=xxx'
    const res = await GET(makeRequest(s3Url) as never)

    const body = await res.json()
    expect(res.status).toBe(502)
    expect(body.error).toMatch(/failed to fetch/i)
  })

  it('streams response body when Content-Length is absent (chunked transfer)', async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: 'user-1', email: 'test@psd401.net' })
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      // No Content-Length — simulates chunked transfer encoding
      headers: new Headers({ 'Content-Type': 'text/csv' }),
      body: null,
    })

    const s3Url = 'https://bucket.s3.amazonaws.com/exports/data.csv?X-Amz-Credential=xxx'
    const res = await GET(makeRequest(s3Url) as never)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
  })
})
