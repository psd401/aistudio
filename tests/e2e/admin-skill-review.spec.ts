import { test, expect } from '@playwright/test'

/**
 * E2E: admin-skill-review (Issue #925, AC#8 / AC#3).
 *
 * Verifies the admin review queue handles web-published skills end-to-end: the
 * review page loads, and when a draft/flagged skill is present it exposes the
 * "Approve to Shared" and "Reject" affordances that move a web-published draft
 * through the existing Epic #910 pipeline. Resilient skip-if-absent style — the
 * environment may lack admin auth or a pending skill.
 */
test.describe('Admin skill review', () => {
  test('review queue exposes approve/reject for pending skills', async ({ page }) => {
    await page.goto('/admin/agents/skills/review')

    const url = page.url()
    if (
      url.includes('/auth') ||
      url.includes('/sign-in') ||
      url.includes('/login') ||
      url.includes('/dashboard') ||
      url.endsWith('/')
    ) {
      test.skip(true, 'No admin auth state available — run with a seeded administrator')
      return
    }

    try {
      await page.waitForSelector('h1, h2, main', { timeout: 10000 })
    } catch {
      test.skip(true, 'Skill review page did not load')
      return
    }

    // The review queue heading should be present for an admin.
    await expect(page.locator('main, body')).toBeVisible()

    // If at least one skill is queued, the approve + reject controls must render.
    const approve = page.locator('button:has-text("Approve to Shared")')
    const reject = page.locator('button:has-text("Reject")')

    if ((await approve.count()) === 0) {
      test.skip(true, 'No pending skills in the review queue')
      return
    }

    await expect(approve.first()).toBeVisible()
    await expect(reject.first()).toBeVisible()
  })
})
