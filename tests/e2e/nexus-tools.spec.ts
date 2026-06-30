import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { authenticateContext } from './helpers/session-auth'

// Authenticated functional spec: skip when no minted session, and inject the
// session cookie before every test (was missing — the suite ran unauthenticated
// and every test redirected to sign-in). See docs/guides/e2e-authenticated-testing.md.
test.skip(
  !process.env.PLAYWRIGHT_AUTH_ENABLED,
  'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true'
)
test.beforeEach(async ({ page }) => {
  await authenticateContext(page.context())
})

test.describe('Nexus AI Tools Integration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10000 })
  })

  // nexus auto-selects a model on load, so the composer's Tools control is enabled
  // without a manual pick. Open the Tools popover and wait until its content shows.
  async function openTools(page: Page) {
    const toolsButton = page.getByRole('button', { name: /Tools/ })
    await expect(toolsButton).toBeEnabled({ timeout: 15000 })
    await toolsButton.click()
    await expect(page.getByRole('heading', { name: 'AI Tools' })).toBeVisible()
  }

  test("opens the Tools control and renders the model's tool state", async ({ page }) => {
    await openTools(page)
    // The panel shows either tool switches (model supports tools) or a clear
    // "no tools" message — both are valid renders depending on the model's config.
    if (await page.getByRole('switch').first().isVisible().catch(() => false)) {
      await expect(page.getByRole('switch').first()).toBeVisible()
    } else {
      await expect(page.getByText(/No tools available/i)).toBeVisible()
    }
  })

  test('toggles a tool when the selected model offers one', async ({ page }) => {
    await openTools(page)
    const firstSwitch = page.getByRole('switch').first()
    const hasTools = await firstSwitch.isVisible().catch(() => false)
    test.skip(!hasTools, 'The selected model offers no tools in this seed environment')
    const wasOn = await firstSwitch.isChecked()
    await firstSwitch.click()
    await expect(firstSwitch).toBeChecked({ checked: !wasOn })
    await firstSwitch.click()
    await expect(firstSwitch).toBeChecked({ checked: wasOn })
  })

  test('opens the model picker and lists selectable models', async ({ page }) => {
    const picker = page.getByRole('button', { name: /Select AI model/i })
    await expect(picker).toBeVisible({ timeout: 15000 })
    await picker.click()
    await expect(page.getByRole('heading', { name: 'AI Model' })).toBeVisible()
    await expect(page.getByText('Choose the model for this conversation')).toBeVisible()
  })

})

test.describe('Tool Registry API', () => {
  test('should return available tools for a model', async ({ request }) => {
    // This would test the API endpoint that returns model capabilities
    // For now, we'll test that the model has nexus_capabilities data
    
    test.skip(true, 'API endpoint test - would require direct database access or API route')
  })
})