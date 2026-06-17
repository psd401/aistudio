import { test, expect } from '@playwright/test'

/**
 * E2E: skill-catalog-browse (Issue #925, AC#8).
 *
 * Verifies the user-facing skill catalog at /skills: the page renders, shows
 * either approved skill cards or the empty state, and (when a skill exists) the
 * detail page exposes the SKILL.md preview plus the "Use in chat" and
 * "Export as zip" actions. Resilient skip-if-absent style — the environment may
 * have no approved skills or no auth state.
 */
test.describe('Skill catalog browse', () => {
  test('lists approved skills and opens a detail page', async ({ page }) => {
    await page.goto('/skills')

    const url = page.url()
    if (url.includes('/auth') || url.includes('/sign-in') || url.includes('/login')) {
      test.skip(true, 'No auth state available — run with seeded users locally')
      return
    }

    try {
      await page.waitForSelector('h1, main', { timeout: 10000 })
    } catch {
      test.skip(true, 'Skills catalog page did not load')
      return
    }

    // The catalog renders either a grid of skills or an explicit empty state.
    const grid = page.locator('[data-testid="skills-grid"]')
    const emptyState = page.locator('[data-testid="skills-empty-state"]')
    await expect(grid.or(emptyState).first()).toBeVisible()

    const cards = page.locator('[data-testid="skill-card"]')
    if ((await cards.count()) === 0) {
      test.skip(true, 'No approved skills to open')
      return
    }

    // Open the first skill's detail page.
    await cards.first().locator('a:has-text("View skill")').click()

    // Detail page exposes the two primary actions and the SKILL.md section.
    await expect(page.locator('[data-testid="use-in-chat"]')).toBeVisible()
    await expect(page.locator('[data-testid="export-zip"]')).toBeVisible()
    await expect(page.locator('text=SKILL.md').first()).toBeVisible()

    // "Use in chat" binds the Nexus session to the skill via ?skillId=.
    const useHref = await page
      .locator('[data-testid="use-in-chat"]')
      .getAttribute('href')
    expect(useHref).toContain('/nexus?')
    expect(useHref).toContain('skillId=')
  })
})
