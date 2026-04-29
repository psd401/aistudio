import { test, expect } from '@playwright/test'

test.describe('Model Compare Polling Migration', () => {
  test.beforeEach(async ({ page }) => {
    // Go to compare page
    await page.goto('/compare')
    
    // Wait for page load
    await page.waitForSelector('h1:has-text("Model Comparison")', { timeout: 10000 })
  })

  test('should display model comparison interface', async ({ page }) => {
    // Check that the page title is visible
    await expect(page.locator('h1')).toContainText('Model Comparison')
    
    // Check that model selectors are present
    const modelSelectors = page.locator('[data-testid="model-selector"]')
    await expect(modelSelectors).toHaveCount(2)
    
    // Check that prompt input is present
    await expect(page.locator('textarea')).toBeVisible()
    
    // Check that submit button is present
    await expect(page.locator('button:has-text("Compare Models")')).toBeVisible()
  })

  test('should require both models to be selected', async ({ page }) => {
    // Try to submit without selecting models
    const promptInput = page.locator('textarea')
    await promptInput.fill('Test prompt')
    
    const compareButton = page.locator('button:has-text("Compare Models")')
    await compareButton.click()
    
    // Should show error toast
    await expect(page.locator('[role="alert"]')).toContainText('Select both models')
  })

  test('should require a prompt', async ({ page }) => {
    // Select two different models (if available)
    const modelSelectors = page.locator('[data-testid="model-selector"]')
    
    // Try to find and select models
    if (await modelSelectors.count() >= 2) {
      await modelSelectors.nth(0).click()
      const firstModelOption = page.locator('[data-testid="model-option"]').first()
      if (await firstModelOption.count() > 0) {
        await firstModelOption.click()
      }
      
      await modelSelectors.nth(1).click()
      const secondModelOption = page.locator('[data-testid="model-option"]').nth(1)
      if (await secondModelOption.count() > 0) {
        await secondModelOption.click()
      }
    }
    
    // Try to submit without prompt
    const compareButton = page.locator('button:has-text("Compare Models")')
    await compareButton.click()
    
    // Should show error toast
    await expect(page.locator('[role="alert"]')).toContainText('Enter a prompt')
  })

  test.skip('should prevent comparing same model', async ({ page }) => {
    // TODO: Verify that selecting the same model in both dropdowns is prevented
  })

  test.skip('should start comparison with valid inputs', async ({ page }) => {
    // TODO: Full comparison flow with mocked SSE responses
  })

  test.skip('should handle polling updates correctly', async ({ page }) => {
    // TODO: Mock API responses, verify partial content updates and final results
  })

  test.skip('should handle job failures gracefully', async ({ page }) => {
    // TODO: Simulate job failures and verify error handling
  })

  test.skip('should save results to comparison history', async ({ page }) => {
    // TODO: Verify completed comparisons persist to comparison history
  })

  test('should allow starting new comparison', async ({ page }) => {
    // This test would verify the "New Comparison" functionality
    // that clears results and allows starting fresh
    const newComparisonButton = page.locator('button:has-text("New Comparison")')
    
    if (await newComparisonButton.isVisible()) {
      await newComparisonButton.click()
      
      // Verify that responses are cleared
      const responseAreas = page.locator('[data-testid="model-response"]')
      for (let i = 0; i < await responseAreas.count(); i++) {
        await expect(responseAreas.nth(i)).toBeEmpty()
      }
      
      // Verify that prompt is cleared
      await expect(page.locator('textarea')).toHaveValue('')
    }
  })
})

test.describe('Compare API Integration', () => {
  test.skip('should handle API errors gracefully', async ({ page }) => {
    // TODO: Mock network errors, trigger comparison, verify error toast
  })

  test.skip('should handle polling timeout gracefully', async ({ page }) => {
    // TODO: Simulate polling timeout and verify graceful degradation
  })

  test('SSE warning event shows unavailable toast and does not leave spinner running', async ({ page }) => {
    // Model2 emits warning (transient failure) — model1 completes normally.
    // Verifies: toast appears with model name, spinner stops for model2, model1 content renders.
    //
    // Both /api/models and /api/compare are mocked so this test runs without live infrastructure.

    // Inject two distinct models so the model selectors are populated and the
    // compare button becomes enabled without depending on live model data.
    // capabilities must include 'chat' because useModelsWithPersistence('compareModel1', ['chat'])
    // uses meetsRequiredCapabilities() to filter models for auto-selection.
    const mockModels = [
      { id: 1, modelId: 'gpt-4o', name: 'GPT-4o', provider: 'openai', active: true, nexusEnabled: false, capabilities: '["chat"]' },
      { id: 2, modelId: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'bedrock', active: true, nexusEnabled: false, capabilities: '["chat"]' },
    ]
    await page.route('/api/models', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: mockModels }),
      })
    })

    const sseBody = [
      'data: {"modelId":"model1","type":"content","chunk":"Hello from model 1"}\n\n',
      'data: {"modelId":"model1","type":"finish","finishReason":"stop"}\n\n',
      'data: {"modelId":"model2","type":"warning","warning":"Comparison unavailable — model response could not be generated"}\n\n',
      'data: {"modelId":"model2","type":"finish","finishReason":"error"}\n\n',
    ].join('')

    await page.route('/api/compare', route => {
      route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
        body: sseBody,
      })
    })

    await page.goto('/compare')
    await page.waitForSelector('h1:has-text("Model Comparison")', { timeout: 10000 })

    await page.locator('textarea').fill('Test prompt')
    const compareButton = page.locator('button:has-text("Compare Models")')

    // With mocked model data the button should be enabled once both selectors are populated.
    // If not enabled (e.g. auth redirected, selector UI changed), fail explicitly.
    await expect(compareButton).toBeEnabled({ timeout: 5000 })
    await compareButton.click()

    // Warning toast should appear
    await expect(page.locator('[role="alert"]')).toContainText('unavailable', { timeout: 5000 })

    // Model1 content should render
    await expect(page.locator('text=Hello from model 1')).toBeVisible({ timeout: 5000 })

    // No streaming spinner should remain visible after both models complete
    await expect(page.locator('[data-testid="streaming-indicator"]')).not.toBeVisible({ timeout: 5000 })
  })
})
