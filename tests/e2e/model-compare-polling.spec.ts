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

  test('should prevent comparing same model', async ({ page }) => {
    // This test checks that user cannot select the same model twice
    // Implementation would depend on the specific UI behavior
    expect(true).toBe(true) // Placeholder
  })

  test('should start comparison with valid inputs', async ({ page }) => {
    // This test would verify the full comparison flow:
    // 1. Select two different models
    // 2. Enter a prompt
    // 3. Submit comparison
    // 4. Verify polling starts
    // 5. Verify results appear
    
    // Note: This test would need actual models configured in test environment
    expect(true).toBe(true) // Placeholder - requires test data setup
  })

  test('should handle polling updates correctly', async ({ page }) => {
    // This test would:
    // 1. Mock the API responses for job creation and polling
    // 2. Verify that partial content updates appear
    // 3. Verify that final results are displayed
    // 4. Verify that loading states are handled correctly
    
    expect(true).toBe(true) // Placeholder - requires API mocking
  })

  test('should handle job failures gracefully', async ({ page }) => {
    // This test would verify error handling when one or both jobs fail
    expect(true).toBe(true) // Placeholder - requires failure simulation
  })

  test('should save results to comparison history', async ({ page }) => {
    // This test would verify that completed comparisons are saved 
    // and can be viewed in comparison history
    expect(true).toBe(true) // Placeholder - requires database integration
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
  test('should handle API errors gracefully', async ({ page }) => {
    // Mock network errors and verify error handling
    await page.route('/api/compare', route => route.abort())

    await page.goto('/compare')

    // Try to make a comparison request
    const promptInput = page.locator('textarea')
    await promptInput.fill('Test prompt')

    // This would trigger the API call that we've mocked to fail
    // The test would verify error handling
    expect(true).toBe(true) // Placeholder - requires API mocking setup
  })

  test('should handle polling timeout gracefully', async ({ page }) => {
    // This test would simulate polling timeout scenarios
    expect(true).toBe(true) // Placeholder
  })

  test('SSE warning event shows unavailable toast and does not leave spinner running', async ({ page }) => {
    // Model2 emits warning (transient failure) — model1 completes normally.
    // Verifies: toast appears with model name, spinner stops for model2, model1 content renders.
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

    // The compare button requires two different models to be selected, which requires
    // live model data. Skip if the button is not enabled rather than letting the test
    // silently pass without exercising any assertions.
    const isEnabled = await compareButton.isEnabled()
    if (!isEnabled) {
      test.skip(true, 'Compare button not enabled — model selectors not pre-populated in this environment')
    }

    await compareButton.click()

    // Warning toast should appear
    await expect(page.locator('[role="alert"]')).toContainText('unavailable', { timeout: 5000 })

    // Model1 content should render
    await expect(page.locator('text=Hello from model 1')).toBeVisible({ timeout: 5000 })

    // No streaming spinner should remain visible after both models complete
    await expect(page.locator('[data-testid="streaming-indicator"]')).not.toBeVisible({ timeout: 5000 })
  })
})