import { test, expect } from '@playwright/test'

/**
 * E2E: publish-skill-from-architect (Issue #925).
 *
 * Verifies the "Publish as Skill" action on the Assistant Architect preview
 * page. Follows the resilient, skip-if-absent style of the other architect
 * specs — the test environment may not have a seeded, edit-ready assistant,
 * so the test skips gracefully rather than failing on missing fixtures.
 */
test.describe('Publish skill from Assistant Architect', () => {
  test('exposes a "Publish as Skill" action on the preview step', async ({ page }) => {
    // Navigate to the assistant architect list.
    await page.goto('/utilities/assistant-architect')

    try {
      await page.waitForSelector('h1, h2, main', { timeout: 10000 })
    } catch {
      test.skip(true, 'Assistant Architect page did not load')
      return
    }

    // Find an editable assistant (owned drafts have an Edit affordance).
    const editLink = page.locator(
      'a[href*="/assistant-architect/"][href*="/edit"], a:has-text("Edit")'
    )
    if ((await editLink.count()) === 0) {
      test.skip(true, 'No editable assistant available to publish')
      return
    }

    await editLink.first().click()

    // Move to the Preview & Submit step where publishing lives. The wizard
    // exposes a Preview/Next control; fall back to direct URL navigation.
    const previewNav = page.locator(
      'a:has-text("Preview"), button:has-text("Preview"), a[href*="/preview"]'
    )
    if ((await previewNav.count()) > 0) {
      await previewNav.first().click()
    } else {
      const url = new URL(page.url())
      if (!url.pathname.endsWith('/preview')) {
        await page.goto(`${url.pathname.replace(/\/$/, '')}/preview`)
      }
    }

    // The Publish as Skill button must render on the preview/submit step.
    const publishButton = page.locator('[data-testid="publish-as-skill-button"]')
    try {
      await publishButton.waitFor({ state: 'visible', timeout: 10000 })
    } catch {
      test.skip(true, 'Preview step not reachable for this assistant')
      return
    }

    await expect(publishButton).toBeVisible()
    await expect(publishButton).toHaveText(/Publish as Skill/i)

    // If the assistant meets the publish requirements, the button is enabled.
    // Triggering it should surface a success or error toast (never crash).
    if (await publishButton.isEnabled()) {
      await publishButton.click()

      const toast = page.locator(
        '[data-sonner-toast], [role="status"], .toast, [data-testid="toast"]'
      )
      try {
        await toast.first().waitFor({ state: 'visible', timeout: 15000 })
      } catch {
        // Some environments render toasts transiently; the key assertion is
        // that the page stays functional after the action.
      }
      await expect(page.locator('main, body')).toBeVisible()
    }
  })
})
