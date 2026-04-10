import { test, expect } from '@playwright/test'

/**
 * E2E tests for the voice configuration endpoint.
 *
 * Tests the GET /api/nexus/voice HTTP endpoint which returns voice
 * configuration and availability. The WebSocket voice streaming itself
 * requires microphone access and a Gemini Live API key, so WebSocket
 * tests are limited to connection-level behavior.
 *
 * Issue #872
 */
test.describe('Voice Configuration API', () => {
  test('GET /api/nexus/voice returns 401 for unauthenticated requests', async ({ request }) => {
    const response = await request.get('/api/nexus/voice')
    expect(response.status()).toBe(401)

    const body = await response.json()
    expect(body.error).toBe('Unauthorized')
  })

  test('GET /api/nexus/voice returns JSON with expected shape when authenticated', async ({ page, request }) => {
    // Navigate to trigger auth session
    await page.goto('/nexus')

    // Wait for auth to settle
    try {
      await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10000 })
    } catch {
      // Skip if auth not available in test env
      test.skip(true, 'Authentication not available in test environment')
      return
    }

    // Use the page's authenticated context to make the API call
    const response = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/voice')
      return { status: res.status, body: await res.json() }
    })

    // Should either be 200 (with config) or 403 (no voice-mode access)
    expect([200, 403]).toContain(response.status)

    if (response.status === 200) {
      // Verify response shape
      expect(response.body).toHaveProperty('available')
      expect(response.body).toHaveProperty('provider')
      expect(response.body).toHaveProperty('model')
      expect(response.body).toHaveProperty('language')
      expect(response.body).toHaveProperty('wsEndpoint', '/api/nexus/voice')
    }
  })
})
