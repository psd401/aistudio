import { test, expect, type Page } from './fixtures'

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
 * Auth requirement: these tests navigate to /nexus and invoke real polling
 * hooks. They require an authenticated Playwright context — useExecutionResults
 * and NotificationProvider both gate their initial fetches on
 * sessionStatus === 'authenticated'. Without a live authenticated session the
 * hooks skip the fetch entirely and waitForResponse() would time out.
 * Run locally with a seeded session or set PLAYWRIGHT_AUTH_ENABLED=true in CI.
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

test.use({ storageState: 'tests/e2e/.auth/user-a.json' })

test.describe('Polling Session Guards — useExecutionResults', () => {
  test.skip(!process.env.PLAYWRIGHT_AUTH_ENABLED, 'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run')

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

    // Positive assertion: open the MessageCenter and confirm results were
    // cleared (setResults([]) is the observable side-effect of the 401 path).
    // This also verifies the assertion above is not vacuously true — the
    // component must be rendered and interactable for empty state to appear.
    await page.getByRole('button', { name: 'Messages & Results' }).click()
    await expect(page.getByText('No execution results yet')).toBeVisible({ timeout: 3000 })
  })

  test('401 response does not trigger rapid retry — next poll respects 60s interval', async ({ page }) => {
    // Install fake clock BEFORE navigation so timers are controlled from mount
    await page.clock.install()

    // requestTimestamps uses wall-clock Date.now() (Node.js process, not browser).
    // Only .length is checked — do not add timing-gap assertions without
    // switching to page.evaluate(() => Date.now()) for fake-clock time.
    //
    // Note: 401 takes the early-return path before the catch block, so
    // consecutiveFailures is NOT incremented — next poll uses the base 60s
    // interval with no backoff applied.
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
  test.skip(!process.env.PLAYWRIGHT_AUTH_ENABLED, 'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run')

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
  test.skip(!process.env.PLAYWRIGHT_AUTH_ENABLED, 'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run')

  test('consecutive 500 failures delay next poll by 2× base interval', async ({ page }) => {
    // Install fake clock BEFORE navigation to control timer scheduling
    await page.clock.install()

    let recentRequests = 0
    await page.route('/api/execution-results/recent*', (route) => {
      recentRequests++
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

    // Initial mount fetch. NOTE: this runs OUTSIDE the polling chain
    // (useExecutionResults calls fetchResults() directly in a mount effect
    // with .catch(() => {})), so its 500 does NOT increment the hook's
    // consecutiveFailures.
    await Promise.all([
      page.waitForResponse('/api/execution-results/recent*'),
      gotoNexus(page),
    ])
    expect(recentRequests).toBe(1)

    // usePollingWithBackoff schedules the FIRST poll at mount, before any
    // failure is registered: base 60s ± 10% jitter = 54–66s (fake time). That
    // poll's 500 sets consecutiveFailures = 1, so the SECOND poll follows
    // 2¹ × 60s ± 10% = 108–132s later. Advance the fake clock in small steps
    // with a real-time yield after each jump — fastForward fires due timers
    // but does not pump the page's promise queue, so the app needs real
    // cycles to process each 500 and reschedule with backoff. (A single big
    // fastForward races that reschedule, and jumping to exactly 60s made the
    // old version of this spec a per-attempt coin flip on the first poll's
    // jitter draw.) Record the fake elapsed time at which each poll lands.
    const pollSeenAtMs: number[] = []
    let fakeElapsedMs = 0
    while (pollSeenAtMs.length < 2 && fakeElapsedMs < 250_000) {
      await page.clock.fastForward(2_000)
      fakeElapsedMs += 2_000
      await page.waitForTimeout(20)
      if (recentRequests >= 2 && pollSeenAtMs.length === 0) pollSeenAtMs.push(fakeElapsedMs)
      if (recentRequests >= 3 && pollSeenAtMs.length === 1) pollSeenAtMs.push(fakeElapsedMs)
    }
    expect(pollSeenAtMs).toHaveLength(2)
    const [firstPollAt, secondPollAt] = pollSeenAtMs

    // First poll: base interval with jitter (54–66s). Upper bound is loose
    // (2s step granularity + real-cycle drift under load) but still far below
    // the 108s backoff minimum, so it cannot mask a missing backoff.
    expect(firstPollAt).toBeGreaterThanOrEqual(54_000)
    expect(firstPollAt).toBeLessThanOrEqual(80_000)

    // Backoff proof: the post-failure gap is 108–132s (fake), while an
    // un-backed-off base gap tops out at ~66s + drift. 90s splits the two
    // ranges with ≥14s of margin on each side.
    expect(secondPollAt - firstPollAt).toBeGreaterThan(90_000)
  })
})
