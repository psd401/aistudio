import { test, expect, type Page } from '@playwright/test'

/**
 * Regression test for Issue #868: Message duplication and empty user bubble.
 *
 * Verifies that:
 * 1. Sending the first message produces exactly one user bubble (no duplicate)
 * 2. No empty user bubbles appear after sending a message
 * 3. The AI response appears exactly once (no duplicates during streaming)
 *
 * Auth requirement: these tests navigate to /nexus (a protected route) and
 * send real messages. They require an authenticated Playwright context.
 * Run locally with a seeded session or set PLAYWRIGHT_AUTH_ENABLED=true in CI.
 */

/** Navigates to /nexus and fails immediately if the app redirects to login. */
async function gotoNexus(page: Page) {
  await page.goto('/nexus')
  // If unauthenticated the app redirects to /api/auth/signin — fail fast
  // rather than silently timing out on waitForSelector.
  await page.waitForURL((url) => !url.pathname.includes('/auth/signin'), { timeout: 10000 })
  await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10000 })
}

test.describe('Nexus Message Deduplication (#868)', () => {
  test.skip(!process.env.PLAYWRIGHT_AUTH_ENABLED, 'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run')

  test('first message should not create empty or duplicate user bubbles', async ({ page }) => {
    await gotoNexus(page)

    // Wait for the composer input to be ready
    const composerInput = page.locator('[aria-label="Message input"]')
    await expect(composerInput).toBeVisible({ timeout: 10000 })

    // Type a message
    const testMessage = 'Hello, this is a test message for dedup verification'
    await composerInput.fill(testMessage)

    // Send the message
    const sendButton = page.locator('[aria-label="Send message"]')
    await sendButton.click()

    // Wait for user message bubble to appear
    const userBubbles = page.locator('[data-role="user"]')
    await expect(userBubbles.first()).toBeVisible({ timeout: 5000 })

    // Verify exactly ONE user bubble exists (no duplicates)
    await expect(userBubbles).toHaveCount(1)

    // Verify the user bubble contains the message text (not empty)
    await expect(userBubbles.first()).toContainText(testMessage)

    // Verify no empty user bubbles — all user messages should have text content
    const userBubbleTexts = await userBubbles.allTextContents()
    for (const text of userBubbleTexts) {
      expect(text.trim().length).toBeGreaterThan(0)
    }
  })

  test('AI response should appear exactly once during streaming', async ({ page }) => {
    await gotoNexus(page)

    // Wait for the composer input
    const composerInput = page.locator('[aria-label="Message input"]')
    await expect(composerInput).toBeVisible({ timeout: 10000 })

    // Send a simple message
    await composerInput.fill('Say hello in one sentence')
    const sendButton = page.locator('[aria-label="Send message"]')
    await sendButton.click()

    // Wait for assistant response to start appearing
    const assistantBubbles = page.locator('[data-role="assistant"]')
    await expect(assistantBubbles.first()).toBeVisible({ timeout: 30000 })

    // Wait for streaming to complete (stop button disappears)
    await page.locator('[aria-label="Stop generating"]').waitFor({ state: 'hidden', timeout: 60000 })

    // After streaming completes, verify exactly ONE assistant bubble
    await expect(assistantBubbles).toHaveCount(1)

    // Verify the assistant bubble has content (not empty)
    const assistantText = await assistantBubbles.first().textContent()
    expect(assistantText?.trim().length).toBeGreaterThan(0)

    // Verify still exactly one user bubble
    const userBubbles = page.locator('[data-role="user"]')
    await expect(userBubbles).toHaveCount(1)
  })
})
