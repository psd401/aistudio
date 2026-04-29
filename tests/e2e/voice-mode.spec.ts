/**
 * E2E tests for Voice Mode UI
 *
 * Tests the voice button visibility, overlay open/close behavior,
 * and keyboard interaction. Does NOT test actual audio capture/playback
 * (Web Audio API is not available in Playwright).
 *
 * Issue #873, #876
 */

import { test, expect } from '@playwright/test'

test.describe('Voice Mode', () => {
  test.describe('Voice button visibility', () => {
    test('voice button is hidden when voice mode is disabled by administrator', async ({ page }) => {
      // Mock the availability endpoint — hook now calls /api/nexus/voice/availability
      await page.route('**/api/nexus/voice/availability', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ available: false, reason: 'Voice mode is disabled by administrator' }),
        })
      )

      await page.goto('/nexus')
      await page.waitForSelector('[data-role="user"], [placeholder="How can I help you today?"]', { timeout: 10000 })

      // Voice button should not be present
      const voiceButton = page.getByTestId('voice-mode-button')
      await expect(voiceButton).not.toBeAttached()
    })

    test('voice button is hidden when user lacks voice-mode permission', async ({ page }) => {
      await page.route('**/api/nexus/voice/availability', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ available: false, reason: 'Voice mode is not enabled for your role' }),
        })
      )

      await page.goto('/nexus')
      await page.waitForSelector('[data-role="user"], [placeholder="How can I help you today?"]', { timeout: 10000 })

      const voiceButton = page.getByTestId('voice-mode-button')
      await expect(voiceButton).not.toBeAttached()
    })

    test('voice button is hidden when voice provider is not configured', async ({ page }) => {
      await page.route('**/api/nexus/voice/availability', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ available: false, reason: 'Voice mode is not currently available' }),
        })
      )

      await page.goto('/nexus')
      await page.waitForSelector('[data-role="user"], [placeholder="How can I help you today?"]', { timeout: 10000 })

      const voiceButton = page.getByTestId('voice-mode-button')
      await expect(voiceButton).not.toBeAttached()
    })

    test('voice button is visible when voice mode is available', async ({ page }) => {
      await page.route('**/api/nexus/voice/availability', (route) =>
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
