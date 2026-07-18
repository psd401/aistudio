import { test, expect } from './fixtures'
import { authenticateContext } from './helpers/session-auth'

test.describe('Assistant Architect model routing', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires the authenticated local E2E harness'
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  test('new assistants default to Standard and Advanced reveals only family choices', async ({ page }) => {
    await page.goto('/utilities/assistant-architect/create')

    const routing = page.getByTestId('assistant-model-routing-section')
    await expect(routing).toBeVisible()
    await expect(page.getByTestId('assistant-routing-standard')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('assistant-routing-family-flyout')).toHaveCount(0)

    await page.getByTestId('assistant-routing-advanced').click()
    await expect(page.getByTestId('assistant-routing-family-flyout')).toBeVisible()
    await expect(page.getByTestId('assistant-routing-family')).toContainText('Claude')
  })

  test('Standard prompt editor hides the exact model chooser', async ({ page }) => {
    await page.goto('/utilities/assistant-architect/9010/edit/prompts')
    await page.getByRole('button', { name: 'Add Prompt' }).click()

    await expect(page.getByTestId('assistant-prompt-automatic-model')).toBeVisible()
    await expect(page.getByTestId('assistant-prompt-pinned-model')).toHaveCount(0)
    await expect(page.getByText('Standard routing chooses the right model for each execution.')).toBeVisible()
  })

  test('Standard prompts save successfully without choosing an exact model', async ({ page }) => {
    const promptName = `Routed prompt ${Date.now()}`
    await page.goto('/utilities/assistant-architect/9010/edit/prompts')
    await page.getByRole('button', { name: 'Add Prompt' }).click()

    await page.locator('#prompt-name').fill(promptName)
    const editor = page.locator('.mdxeditor-root-contenteditable [contenteditable="true"]')
      .or(page.locator('.mdxeditor-root-contenteditable[contenteditable="true"]'))
      .first()
    await editor.fill('Create a concise standards-aligned lesson plan.')
    await page.getByRole('button', { name: 'Add Prompt', exact: true }).last().click()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText(promptName, { exact: true })).toBeVisible()
    await expect(page.getByText('Standard', { exact: true }).last()).toBeVisible()
  })

  test('legacy assistants retain their pinned model chooser until converted', async ({ page }) => {
    await page.goto('/utilities/assistant-architect/9000/edit/prompts')
    await page.getByRole('button', { name: 'Add Prompt' }).click()

    await expect(page.getByTestId('assistant-prompt-pinned-model')).toBeVisible()
    await expect(page.getByTestId('assistant-prompt-automatic-model')).toHaveCount(0)
  })
})
