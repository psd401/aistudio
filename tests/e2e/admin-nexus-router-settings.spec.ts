import { test, expect } from './fixtures'
import { authenticateContext } from './helpers/session-auth'

test.describe('Admin Nexus router settings', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires the authenticated host dev server'
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
    await page.goto('/admin/settings')
  })

  test('renders rollout, tier, classifier, web-search, image, instruction, and PSD-data controls', async ({ page }) => {
    await expect(page.getByTestId('nexus-router-settings-card')).toBeVisible()
    await expect(page.getByTestId('nexus-router-admin-mode')).toBeVisible()
    await expect(page.getByTestId('assistant-architect-router-admin-mode')).toBeVisible()
    await expect(page.getByTestId('nexus-router-auto-light')).toBeVisible()
    await expect(page.getByTestId('nexus-router-auto-medium')).toBeVisible()
    await expect(page.getByTestId('nexus-router-auto-high')).toBeVisible()
    await expect(page.getByTestId('nexus-router-openai-medium')).toBeVisible()
    await expect(page.getByTestId('nexus-router-anthropic-medium')).toBeVisible()
    await expect(page.getByTestId('nexus-router-google-medium')).toBeVisible()
    await expect(page.getByTestId('nexus-router-instruction-model')).toBeVisible()
    await expect(page.getByTestId('nexus-router-web-search-model')).toBeVisible()
    await expect(page.getByTestId('nexus-router-image-model')).toBeVisible()
    await expect(page.getByTestId('nexus-router-psd-connector')).toBeVisible()
    await expect(page.getByTestId('nexus-router-classifier-model')).toHaveValue('us.amazon.nova-micro-v1:0')
    await expect(page.getByTestId('nexus-router-admin-save')).toBeEnabled()

    const contentPlatformTab = page.getByRole('tab', { name: /Content Platform/ })
    await expect(contentPlatformTab).toBeVisible()
    await contentPlatformTab.click()
    await expect(page.getByText('CONTENT_PLATFORM_ENABLED')).toBeVisible()
    await expect(page.getByText('CONTENT_MAX_IMAGE_SIZE_MB')).toBeVisible()
    await expect(page.getByText('CONTENT_IMAGE_CAPTION_MODEL_ID')).toBeVisible()
    await expect(page.getByText('CONTENT_RETRIEVAL_RERANK_ENABLED')).toBeVisible()
    await expect(page.getByText('CONTENT_RETRIEVAL_RERANK_MODEL_ID')).toBeVisible()
    await expect(page.getByText('CONTENT_RETRIEVAL_CANDIDATE_LIMIT')).toBeVisible()
    await expect(page.getByText('CONTENT_RETRIEVAL_NEIGHBOR_COUNT')).toBeVisible()
    await expect(page.getByText('CONTENT_RETRIEVAL_CONTEXT_TOKENS')).toBeVisible()
    await expect(page.getByText('CONTENT_VISUAL_EMBEDDING_MODEL_ID')).toBeVisible()

    await page.getByRole('button', { name: 'Add Setting' }).click()
    const addSettingDialog = page.getByRole('dialog', { name: 'Add Setting' })
    await expect(addSettingDialog).toBeVisible()
    const dialogBox = await addSettingDialog.boundingBox()
    const viewport = page.viewportSize()
    expect(dialogBox).not.toBeNull()
    expect(viewport).not.toBeNull()
    if (!dialogBox || !viewport) {
      throw new Error('Expected the add-setting dialog and Playwright viewport to be measurable')
    }
    expect(dialogBox.y).toBeGreaterThanOrEqual(0)
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewport.height)

    const createSettingButton = addSettingDialog.getByRole('button', { name: 'Create' })
    await createSettingButton.scrollIntoViewIfNeeded()
    await expect(createSettingButton).toBeInViewport()
    await addSettingDialog.getByRole('button', { name: 'Cancel' }).click()

    const [saveResponse] = await Promise.all([
      page.waitForResponse(response => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/admin/settings'
        && response.request().headers()['next-action'] !== undefined
      )),
      page.getByTestId('nexus-router-admin-save').click(),
    ])

    expect(saveResponse.ok()).toBe(true)
    await expect(page.getByTestId('nexus-router-admin-save')).toBeEnabled()

    await page.reload()
    const reloadedCard = page.getByTestId('nexus-router-settings-card').last()
    await expect(reloadedCard.getByTestId('nexus-router-admin-mode')).toContainText('Active')
    await expect(reloadedCard.getByTestId('assistant-architect-router-admin-mode')).toContainText('Active')
    await expect(reloadedCard.getByTestId('nexus-router-classifier-model')).toHaveValue('us.amazon.nova-micro-v1:0')
  })
})
