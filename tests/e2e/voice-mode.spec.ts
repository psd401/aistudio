/**
 * E2E tests for Voice Mode UI
 *
 * Tests the voice button visibility, overlay open/close behavior,
 * and keyboard interaction. Does NOT test actual audio capture/playback
 * (Web Audio API is not available in Playwright).
 *
 * Issue #873
 */

import { test, expect } from '@playwright/test'

test.describe('Voice Mode', () => {
  test.describe('Voice button visibility', () => {
    test('voice button is hidden when user lacks voice-mode permission', async ({ page }) => {
      // Mock the voice-info endpoint to return unavailable
      await page.route('**/api/nexus/voice-info', (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Voice mode not enabled' }),
        })
      )

      await page.goto('/nexus')
      await page.waitForSelector('[data-role="user"], [placeholder="How can I help you today?"]', { timeout: 10000 })

      // Voice button should not be present
      const voiceButton = page.getByTestId('voice-mode-button')
      await expect(voiceButton).toBeHidden()
    })

    test('voice button is hidden when voice provider is not configured', async ({ page }) => {
      await page.route('**/api/nexus/voice-info', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ available: false }),
        })
      )

      await page.goto('/nexus')
      await page.waitForSelector('[data-role="user"], [placeholder="How can I help you today?"]', { timeout: 10000 })

      const voiceButton = page.getByTestId('voice-mode-button')
      await expect(voiceButton).toBeHidden()
    })

    test('voice button is visible when voice mode is available', async ({ page }) => {
      await page.route('**/api/nexus/voice-info', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ available: true }),
        })
      )

      await page.goto('/nexus')
      await page.waitForSelector('[data-role="user"], [placeholder="How can I help you today?"]', { timeout: 10000 })

      const voiceButton = page.getByTestId('voice-mode-button')
      await expect(voiceButton).toBeVisible()
    })
  })
})
