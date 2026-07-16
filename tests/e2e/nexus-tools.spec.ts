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

  // Standard intentionally hides manual tools. Opt into Advanced/Auto before
  // exercising the legacy optional tool controls.
  async function enableAdvanced(page: Page) {
    const routing = page.getByRole('button', { name: 'Nexus routing mode' })
    await routing.click()
    await page.getByTestId('nexus-family-auto').click()
    await expect(routing).toContainText('Auto')
  }

  async function openTools(page: Page) {
    await enableAdvanced(page)
    const toolsButton = page.getByTestId('nexus-tools-control')
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

  test('toggles a tool when offered or clearly reports that none are available', async ({ page }) => {
    await openTools(page)
    const firstSwitch = page.getByRole('switch').first()
    const hasTools = await firstSwitch.isVisible().catch(() => false)
    if (hasTools) {
      const wasOn = await firstSwitch.isChecked()
      await firstSwitch.click()
      await expect(firstSwitch).toBeChecked({ checked: !wasOn })
      await firstSwitch.click()
      await expect(firstSwitch).toBeChecked({ checked: wasOn })
    } else {
      await expect(page.getByText(/No tools available/i)).toBeVisible()
    }
  })

  test('Advanced uses family routing and never restores the exact-model picker', async ({ page }) => {
    await enableAdvanced(page)
    await expect(page.getByTestId('nexus-tools-control')).toBeVisible()
    await expect(page.getByTestId('nexus-mcp-control')).toBeVisible()
    await expect(page.getByRole('button', { name: /Select AI model/i })).toHaveCount(0)
  })

})
