import { test, expect, type Page } from '@playwright/test'

/**
 * E2E tests for session-expiry polling guards (#837 / #845).
 *
 * Verified behaviors:
 *   - 401 response silently clears results without setting error state
 *   - 401 response does not trigger rapid retry (respects 60s interval)
 *   - NotificationProvider 401 does not surface error toasts
 *   - Consecutive 500 failures increase polling interval (exponential backoff)
 *
 * All tests mock API responses via page.route(). Timing-sensitive tests use
 * page.clock to advance fake timers rather than waiting real time.
 *
 * Tests navigate to /nexus and fail fast if redirected to login — they require
 * an authenticated Playwright context to exercise any polling hooks.
 */

/** Navigates to /nexus and fails immediately if the app redirects to login. */
async function gotoNexus(page: Page) {
  await page.goto('/nexus')
  // If unauthenticated the app redirects to /login — fail fast rather than
  // silently passing with route mocks that were never invoked.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10000 })
}

test.describe('Polling Session Guards — useExecutionResults', () => {
  test('401 response silently clears results without setting error state', async ({ page }) => {
    // All execution-results requests return 401 to exercise the silent-error path
    await page.route('/api/execution-results/recent*', (route) => {
      route.fulfill({ status: 401, body: 'Unauthorized' })
    })

    // Register SSE stream abort BEFORE the wildcard polling mock.
    // Playwright matches routes in reverse registration order, so stream abort
    // takes priority over the catch-all JSON mock below.
    await page.route('/api/notifications/stream', (route) => {
      route.abort()
    })
    await page.route('/api/notifications*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isSuccess: true, data: [] })
      })
    })

    // Wait for the initial fetch response before asserting
    await Promise.all([
      page.waitForResponse('/api/execution-results/recent*'),
      gotoNexus(page),
    ])

    // No error toast/banner should appear — 401 is handled silently
    const alertTexts = await page.locator('[role="alert"]').allTextContents()
    for (const text of alertTexts) {
      expect(text).not.toContain('execution results')
      expect(text.toLowerCase()).not.toContain('401')
    }
  })

  test('401 response does not trigger rapid retry — next poll respects 60s interval', async ({ page }) => {
    // Install fake clock BEFORE navigation so timers are controlled from mount
    await page.clock.install()

    // requestTimestamps uses wall-clock Date.now() (Node.js process, not browser).
    // Only .length is checked — do not add timing-gap assertions without
    // switching to page.evaluate(() => Date.now()) for fake-clock time.
    const requestTimestamps: number[] = []
    await page.route('/api/execution-results/recent*', (route) => {
      requestTimestamps.push(Date.now())
      route.fulfill({ status: 401, body: 'Unauthorized' })
    })

    // SSE stream abort must be registered before the wildcard notifications mock
    await page.route('/api/notifications/stream', (route) => { route.abort() })
    await page.route('/api/notifications*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isSuccess: true, data: [] })
      })
    })

    // Wait for the initial fetch (fires on mount regardless of interval)
    await Promise.all([
      page.waitForResponse('/api/execution-results/recent*'),
      gotoNexus(page),
    ])
    expect(requestTimestamps.length).toBe(1)

    // Advance 45s — well below the jitter floor of 54s (60s × 0.9).
    // No second request should have fired yet.
    await page.clock.fastForward(45000)
    expect(requestTimestamps.length).toBe(1)
  })
})

test.describe('Polling Session Guards — NotificationProvider', () => {
  test('401 from notifications polling endpoint does not produce error state', async ({ page }) => {
    // SSE stream abort registered first (higher priority when using wildcard below)
    await page.route('/api/notifications/stream', (route) => {
      route.abort()
    })
    // Exact-path mock for the polling endpoint only — does not intercept SSE
    await page.route('/api/notifications', (route) => {
      route.fulfill({ status: 401, body: 'Unauthorized' })
    })

    await page.route('/api/execution-results/recent*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isSuccess: true, data: [] })
      })
    })

    // Wait for the notifications fetch to complete before asserting
    await Promise.all([
      page.waitForResponse('/api/notifications'),
      gotoNexus(page),
    ])

    // Silent 401 handling — no error toasts for notifications
    const alertTexts = await page.locator('[role="alert"]').allTextContents()
    for (const text of alertTexts) {
      expect(text.toLowerCase()).not.toContain('failed to fetch notifications')
    }
  })
})

test.describe('Polling Backoff Behavior', () => {
  test('consecutive 500 failures delay next poll by 2× base interval', async ({ page }) => {
    // Install fake clock BEFORE navigation to control timer scheduling
    await page.clock.install()

    // requestTimestamps uses wall-clock Date.now() (Node.js process, not browser).
    // Only .length is checked — do not add timing-gap assertions without
    // switching to page.evaluate(() => Date.now()) for fake-clock time.
    const requestTimestamps: number[] = []
    await page.route('/api/execution-results/recent*', (route) => {
      requestTimestamps.push(Date.now())
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ isSuccess: false, message: 'Internal error' })
      })
    })

    // SSE stream abort before wildcard notifications mock
    await page.route('/api/notifications/stream', (route) => { route.abort() })
    await page.route('/api/notifications*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isSuccess: true, data: [] })
      })
    })

    // Wait for initial fetch (1 failure → consecutiveFailures = 1)
    await Promise.all([
      page.waitForResponse('/api/execution-results/recent*'),
      gotoNexus(page),
    ])
    expect(requestTimestamps.length).toBe(1)

    // After 1 failure, backoff = 2^1 × 60s = 120s (±10% jitter: 108s–132s).
    // Timings here are for useExecutionResults (refreshInterval = 60 000 ms);
    // NotificationProvider uses a 30 s base interval and is a separate concern.
    // At 60s into the backoff window — no second request yet.
    await page.clock.fastForward(60000)
    expect(requestTimestamps.length).toBe(1)

    // At 140s total — past the maximum backoff window (132s).
    // Second request should now fire.
    await page.clock.fastForward(80000)
    // Route handler updates requestTimestamps when the request is fulfilled.
    // poll() gives a clear failure message if the second request never arrives,
    // rather than a silent timeout via .catch(() => {}).
    await expect.poll(() => requestTimestamps.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2)
  })
})
