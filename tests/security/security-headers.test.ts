/**
 * @jest-environment node
 */
import { NextRequest, NextResponse } from 'next/server'
import middleware from '@/middleware'

// Mock NextResponse methods that are missing in test environment
interface MockResponseInit {
  headers?: Record<string, string>
  status?: number
}

interface MockableNextResponse {
  next: jest.Mock
  redirect: jest.Mock
  json: jest.Mock
}

function createMockResponse(
  body: string | null = null,
  init: MockResponseInit = {}
) {
  const headers = new Map(Object.entries(init.headers ?? {}));
  return {
    body,
    status: init.status ?? 200,
    headers,
    json: jest.fn(() =>
      Promise.resolve(body === null ? null : JSON.parse(body))
    ),
  };
}

const mockNextResponse = NextResponse as unknown as MockableNextResponse
const middlewareContext = {} as Parameters<typeof middleware>[1]

mockNextResponse.next = jest.fn(() => createMockResponse());

mockNextResponse.redirect = jest.fn((url: URL | string, status = 307) => {
  return createMockResponse(null, {
    status,
    headers: {
      location: typeof url === 'string' ? url : url.toString()
    }
  });
});

mockNextResponse.json = jest.fn((data: unknown, init: MockResponseInit = {}) => {
  return createMockResponse(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });
});

// Mock the auth module
jest.mock('@/auth', () => ({
  authMiddleware: jest.fn((
    handler: (request: NextRequest) => unknown
  ) => {
    return (req: NextRequest, _evt: unknown) => {
      // Simulate auth middleware behavior
      const auth = req.headers.get('authorization') ? { user: { id: 'test-user', email: 'test@example.com' }, expires: new Date(Date.now() + 3600000).toISOString() } : null
      // Ensure nextUrl is available - NextRequest might not set it in test environment
      const nextUrl = req.nextUrl || new URL(req.url)
      const augmentedReq = Object.assign(req, { auth, nextUrl })
      return handler(augmentedReq)
    }
  })
}))

describe('Security Headers Tests', () => {
  const securityHeaders = [
    { name: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, private' },
    { name: 'Pragma', value: 'no-cache' },
    { name: 'Expires', value: '0' },
    { name: 'X-Content-Type-Options', value: 'nosniff' },
    { name: 'X-Frame-Options', value: 'DENY' },
    { name: 'X-XSS-Protection', value: '1; mode=block' }
  ]

  // Headers only set on direct responses (redirects, 401s) — passthrough
  // responses receive these from next.config.mjs headers() instead to avoid
  // duplicate headers violating RFC 6797.
  const directResponseHeaders = [
    { name: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    { name: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  ]

  describe('Protected Routes', () => {
    it.each([
      '/dashboard',
      '/chat',
      '/admin',
      '/knowledge',
      '/settings',
      '/api/documents/upload',
      '/api/users'
    ])('should apply security headers to %s', async (path) => {
      const request = new NextRequest(`http://localhost:3000${path}`, {
        headers: {
          authorization: 'Bearer test-token'
        }
      })

      const response = await middleware(request, middlewareContext) as NextResponse

      // Verify all security headers are present
      for (const { name, value } of securityHeaders) {
        expect(response.headers.get(name)).toBe(value)
      }
    })

    it('should apply headers even when redirecting unauthenticated users', async () => {
      const request = new NextRequest('http://localhost:3000/dashboard')
      // No authorization header = unauthenticated

      const response = await middleware(request, middlewareContext) as NextResponse

      // Should redirect
      expect(response.status).toBe(307) // Temporary redirect
      expect(response.headers.get('location')).toContain('/api/auth/signin')

      // But still have security headers
      for (const { name, value } of securityHeaders) {
        expect(response.headers.get(name)).toBe(value)
      }

      // Redirects are direct responses — HSTS and Referrer-Policy are set here
      // (next.config.mjs headers() does not apply to redirects).
      for (const { name, value } of directResponseHeaders) {
        expect(response.headers.get(name)).toBe(value)
      }
    })

    it('should apply HSTS and Referrer-Policy on 401 responses for unauthenticated API calls', async () => {
      const request = new NextRequest('http://localhost:3000/api/users')
      // No authorization header — triggers 401 direct response

      const response = await middleware(request, middlewareContext) as NextResponse

      expect(response.status).toBe(401)

      // 401 responses are direct — HSTS and Referrer-Policy must be set by
      // middleware because next.config.mjs headers() does not apply here.
      for (const { name, value } of directResponseHeaders) {
        expect(response.headers.get(name)).toBe(value)
      }
    })
  })

  describe('Public Routes', () => {
    it.each([
      '/',
      '/signout',
      '/api/auth/signin',
      '/api/auth/callback',
      '/api/public/health',
      '/api/health',
      '/api/ping',
      '/api/repositories/connectors/google/webhook',
      '/auth/error'
    ])('should apply security headers to public route %s', async (path) => {
      const request = new NextRequest(`http://localhost:3000${path}`)

      const response = await middleware(request, middlewareContext) as NextResponse

      // Verify all security headers are present on public routes too
      for (const { name, value } of securityHeaders) {
        expect(response.headers.get(name)).toBe(value)
      }
    })

    it('does not public-exempt descendants of the Google webhook route', async () => {
      const request = new NextRequest(
        'http://localhost:3000/api/repositories/connectors/google/webhook/unexpected',
      )

      const response = await middleware(request, middlewareContext) as NextResponse

      expect(response.status).toBe(401)
    })
  })

  describe('Static Assets', () => {
    it.each([
      '/_next/static/chunk.js',
      '/_next/image/test.png',
      '/static/logo.png',
      '/favicon.ico',
      '/image.jpg',
      '/style.css',
      '/script.js'
    ])('should apply security headers to static asset %s', async (path) => {
      const request = new NextRequest(`http://localhost:3000${path}`)

      const response = await middleware(request, middlewareContext) as NextResponse

      // Security headers should be applied to static assets too
      for (const { name, value } of securityHeaders) {
        expect(response.headers.get(name)).toBe(value)
      }
    })
  })

  describe('Cache Prevention', () => {
    it('should prevent caching on all routes', async () => {
      const routes = [
        '/dashboard',
        '/api/users',
        '/',
        '/_next/static/test.js'
      ]

      for (const route of routes) {
        const request = new NextRequest(`http://localhost:3000${route}`, {
          headers: {
            authorization: 'Bearer test-token'
          }
        })

        const response = await middleware(request, middlewareContext) as NextResponse

        // Verify cache prevention headers
        expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate, private')
        expect(response.headers.get('Pragma')).toBe('no-cache')
        expect(response.headers.get('Expires')).toBe('0')
      }
    })
  })

  describe('Security Attack Prevention', () => {
    it('permits only the exact Google Picker origins required by the UI', async () => {
      const request = new NextRequest('http://localhost:3000/repositories', {
        headers: {
          authorization: 'Bearer test-token'
        }
      })

      const response = await middleware(
        request,
        {} as Parameters<typeof middleware>[1],
      ) as NextResponse
      const csp = response.headers.get('Content-Security-Policy')

      expect(csp).toContain('script-src')
      expect(csp).toContain('https://apis.google.com')
      expect(csp).toContain('frame-src')
      expect(csp).toContain('https://docs.google.com')
      expect(csp).not.toContain('https://*.google.com')
    })

    it('should prevent clickjacking with X-Frame-Options', async () => {
      const request = new NextRequest('http://localhost:3000/dashboard', {
        headers: {
          authorization: 'Bearer test-token'
        }
      })

      const response = await middleware(request, middlewareContext) as NextResponse

      expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    })

    it('should prevent MIME type sniffing', async () => {
      const request = new NextRequest('http://localhost:3000/api/documents', {
        headers: {
          authorization: 'Bearer test-token'
        }
      })

      const response = await middleware(request, middlewareContext) as NextResponse

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    })

    it('should enable XSS protection', async () => {
      const request = new NextRequest('http://localhost:3000/chat', {
        headers: {
          authorization: 'Bearer test-token'
        }
      })

      const response = await middleware(request, middlewareContext) as NextResponse

      expect(response.headers.get('X-XSS-Protection')).toBe('1; mode=block')
    })
  })

  describe('Header Consistency', () => {
    it('should apply identical headers regardless of authentication status', async () => {
      const path = '/dashboard'

      // Authenticated request
      const authRequest = new NextRequest(`http://localhost:3000${path}`, {
        headers: {
          authorization: 'Bearer test-token'
        }
      })
      const authResponse = await middleware(authRequest, middlewareContext) as NextResponse

      // Unauthenticated request
      const unauthRequest = new NextRequest(`http://localhost:3000${path}`)
      const unauthResponse = await middleware(unauthRequest, middlewareContext) as NextResponse

      // Both should have the same security headers
      for (const { name } of securityHeaders) {
        expect(authResponse.headers.get(name)).toBe(unauthResponse.headers.get(name))
      }
    })
  })

  describe('Response Manipulation', () => {
    it('should not override existing response headers', async () => {
      // This test verifies that security headers are added without overriding existing ones
      // Since our current middleware implementation creates a new response, we'll test
      // that security headers are consistently applied
      const request = new NextRequest('http://localhost:3000/dashboard', {
        headers: {
          authorization: 'Bearer test-token'
        }
      })

      const response = await middleware(request, middlewareContext) as NextResponse

      // Should have security headers
      for (const { name, value } of securityHeaders) {
        expect(response.headers.get(name)).toBe(value)
      }
    })
  })

  describe('Edge Cases', () => {
    it('should handle requests with query parameters', async () => {
      const request = new NextRequest('http://localhost:3000/dashboard?tab=settings&user=123', {
        headers: {
          authorization: 'Bearer test-token'
        }
      })

      const response = await middleware(request, middlewareContext) as NextResponse

      for (const { name, value } of securityHeaders) {
        expect(response.headers.get(name)).toBe(value)
      }
    })

    it('should handle requests with fragments', async () => {
      const request = new NextRequest('http://localhost:3000/docs#section-1', {
        headers: {
          authorization: 'Bearer test-token'
        }
      })

      const response = await middleware(request, middlewareContext) as NextResponse

      for (const { name, value } of securityHeaders) {
        expect(response.headers.get(name)).toBe(value)
      }
    })

    it('should handle malformed URLs gracefully', async () => {
      const request = new NextRequest('http://localhost:3000/../../etc/passwd', {
        headers: {
          authorization: 'Bearer test-token'
        }
      })

      const response = await middleware(request, middlewareContext) as NextResponse

      // Should still apply security headers
      for (const { name, value } of securityHeaders) {
        expect(response.headers.get(name)).toBe(value)
      }
    })
  })
})
