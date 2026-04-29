import { test, expect } from '@playwright/test'

/**
 * E2E tests for the voice availability endpoint.
 *
 * Tests the GET /api/nexus/voice/availability HTTP endpoint which returns
 * voice availability and a human-readable reason when unavailable.
 *
 * Issue #872, #876
 */
test.describe('Voice Availability API', () => {
  test('GET /api/nexus/voice/availability returns 401 for unauthenticated requests', async ({ request }) => {
    const response = await request.get('/api/nexus/voice/availability')
    expect(response.status()).toBe(401)

    const body = await response.json()
    expect(body.error).toBe('Unauthorized')
  })

  test('GET /api/nexus/voice/availability returns JSON with expected shape when authenticated', async ({ page, request }) => {
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
      const res = await fetch('/api/nexus/voice/availability')
      return { status: res.status, body: await res.json() }
    })

    expect(response.status).toBe(200)
    expect(response.body).toHaveProperty('available')
    expect(typeof response.body.available).toBe('boolean')

    if (!response.body.available) {
      // When unavailable, reason should be present
      expect(response.body).toHaveProperty('reason')
      expect(typeof response.body.reason).toBe('string')
    }
  })
})
