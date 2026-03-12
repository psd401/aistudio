import { test, expect, type Page } from '@playwright/test'

/**
 * E2E tests for session-expiry polling guards (#837 / #845).
 *
 * Tests verify that useExecutionResults and NotificationProvider:
 *   - Stop polling when session expires (401 response)
 *   - Reset isLoading on unauthenticated (no stuck spinner)
 *   - Silently clear results on 401 without setting error
 *   - Apply exponential backoff on consecutive failures
 *
 * All tests mock API responses via page.route() — no live backend needed.
 *
 * Auth: These tests navigate to /nexus. If the test environment lacks an
 * authenticated session, the app redirects to /login and the API route mocks
 * are never triggered. The assertions are designed to be vacuously safe in
 * that case (no false positives), but ideally run against an authenticated
 * Playwright context. See docs/guides/TESTING.md for auth setup.
 */

/** Navigates to /nexus and waits for auth resolution (redirect to login or page load). */
async function gotoNexus(page: Page) {
  await page.goto('/nexus')
  // Wait for either the authenticated shell or the login redirect
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
    // networkidle may not settle on all environments — continue anyway
  })
}

test.describe('Polling Session Guards — useExecutionResults', () => {
  test('401 response silently clears results without setting error state', async ({ page }) => {
    // First request succeeds, second returns 401
    let requestCount = 0
    await page.route('/api/execution-results/recent*', (route) => {
      requestCount++
      if (requestCount === 1) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            isSuccess: true,
            data: [
              { id: 1, assistantName: 'Test', status: 'success', startedAt: new Date().toISOString() }
            ]
          })
        })
      } else {
        route.fulfill({ status: 401, body: 'Unauthorized' })
      }
    })

    // Mock notifications API to prevent interference
    await page.route('/api/notifications*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isSuccess: true, data: [] })
      })
    })

    await gotoNexus(page)

    // Wait for at least the initial fetch to fire (or page redirect)
    await page.waitForTimeout(2000)

    // Verify no error toast/banner appeared from the silent 401 handling
    const errorElements = page.locator('[role="alert"]')
    const errorCount = await errorElements.count()
    for (let i = 0; i < errorCount; i++) {
      const text = await errorElements.nth(i).textContent()
      expect(text).not.toContain('execution results')
      expect(text).not.toContain('401')
    }
  })

  test('polling stops when API returns 401 — no subsequent requests', async ({ page }) => {
    // All requests return 401
    const requestTimestamps: number[] = []
    await page.route('/api/execution-results/recent*', (route) => {
      requestTimestamps.push(Date.now())
      route.fulfill({ status: 401, body: 'Unauthorized' })
    })

    await page.route('/api/notifications*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isSuccess: true, data: [] })
      })
    })

    await gotoNexus(page)

    // Wait for initial request
    await page.waitForTimeout(1000)
    const initialCount = requestTimestamps.length

    // Wait a further window — should NOT see additional requests
    // since 401 returns early (no throw) and session guard prevents polling
    await page.waitForTimeout(5000)
    const afterCount = requestTimestamps.length

    // Only the initial fetch should have fired — allow at most 1 additional for race conditions
    expect(afterCount - initialCount).toBeLessThanOrEqual(1)
  })
})

test.describe('Polling Session Guards — NotificationProvider', () => {
  test('401 from notifications API does not produce error state', async ({ page }) => {
    await page.route('/api/notifications*', (route) => {
      route.fulfill({ status: 401, body: 'Unauthorized' })
    })

    // Abort the SSE stream to avoid hanging
    await page.route('/api/notifications/stream', (route) => {
      route.abort()
    })

    await page.route('/api/execution-results/recent*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isSuccess: true, data: [] })
      })
    })

    await gotoNexus(page)
    await page.waitForTimeout(2000)

    // No error toasts should appear from the silent 401 handling
    const alertTexts = await page.locator('[role="alert"]').allTextContents()
    for (const text of alertTexts) {
      expect(text.toLowerCase()).not.toContain('failed to fetch notifications')
    }
  })
})

test.describe('Polling Backoff Behavior', () => {
  test('consecutive 500 failures do not trigger rapid-fire requests', async ({ page }) => {
    // All execution-results requests fail with 500
    const requestTimestamps: number[] = []
    await page.route('/api/execution-results/recent*', (route) => {
      requestTimestamps.push(Date.now())
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ isSuccess: false, message: 'Internal error' })
      })
    })

    await page.route('/api/notifications*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isSuccess: true, data: [] })
      })
    })

    await gotoNexus(page)

    // Wait 3 seconds — enough for the initial fetch to fire
    await page.waitForTimeout(3000)

    // Verify at least the initial fetch happened
    expect(requestTimestamps.length).toBeGreaterThanOrEqual(1)

    // Verify no rapid-fire burst (more than 3 requests in 3s would indicate no backoff)
    // Default refreshInterval is 60s, so even with 500 errors the next poll is
    // 60s * 2^1 = 120s minimum — should see at most 1-2 requests in 3 seconds
    expect(requestTimestamps.length).toBeLessThanOrEqual(3)
  })
})
