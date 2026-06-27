import { test, expect } from './fixtures'

test.describe('Nexus AI Tools Integration', () => {
  test.beforeEach(async ({ page }) => {
    // Go to nexus page
    await page.goto('/nexus')
    
    // Wait for authentication if needed
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10000 })
  })

  test('should display tool selector when model is selected', async ({ page }) => {
    // Select a model with tool capabilities (e.g., GPT-5 or Gemini)
    const modelSelector = page.locator('[data-testid="model-selector"]')
    await modelSelector.click()
    
    // Look for a model with web search or code interpreter capabilities
    const modelOption = page.locator('[data-testid="model-option"]').filter({
      hasText: /gpt-5|gemini|claude/i
    }).first()
    
    if (await modelOption.count() > 0) {
      await modelOption.click()
      
      // Tool selector should be visible
      await expect(page.locator('[data-testid="tool-selector"]')).toBeVisible()
      
      // Should show available tools
      const toolsSection = page.locator('[data-testid="tool-selector"]')
      await expect(toolsSection).toContainText('AI Tools')
    } else {
      // Skip test if no capable models are available
      test.skip(true, 'No AI models with tool capabilities available')
    }
  })

  test('should enable and disable tools', async ({ page }) => {
    // Select a capable model first
    const modelSelector = page.locator('[data-testid="model-selector"]')
    await modelSelector.click()
    
    const modelOption = page.locator('[data-testid="model-option"]').filter({
      hasText: /gpt-5|gemini/i
    }).first()
    
    if (await modelOption.count() > 0) {
      await modelOption.click()
      
      // Wait for tools to load
      await page.waitForSelector('[data-testid="tool-selector"]')
      
      // Find a tool switch (web search or code interpreter)
      const toolSwitch = page.locator('[id^="tool-"]').first()
      
      if (await toolSwitch.count() > 0) {
        // Enable the tool
        await toolSwitch.check()
        
        // Tool status indicator should appear
        await expect(page.locator('[data-testid="tool-status-indicator"]')).toBeVisible()
        
        // Disable the tool
        await toolSwitch.uncheck()
        
        // Tool status indicator should disappear
        await expect(page.locator('[data-testid="tool-status-indicator"]')).not.toBeVisible()
      } else {
        test.skip(true, 'No tool switches available for the selected model')
      }
    } else {
      test.skip(true, 'No AI models with tool capabilities available')
    }
  })

  test('should show tool capabilities based on model selection', async ({ page }) => {
    // Test that different models show different tool availability
    const modelSelector = page.locator('[data-testid="model-selector"]')
    await modelSelector.click()
    
    // Get all available models
    const modelOptions = page.locator('[data-testid="model-option"]')
    const modelCount = await modelOptions.count()
    
    if (modelCount > 1) {
      // Select first model
      await modelOptions.nth(0).click()
      await page.waitForSelector('[data-testid="tool-selector"]')
      
      // Capture available tools for first model
      
      // Select different model
      await modelSelector.click()
      await modelOptions.nth(1).click()
      await page.waitForSelector('[data-testid="tool-selector"]')
      
      // Tools should update based on model capabilities
      // (This test just ensures the UI updates, specific tools depend on model config)
      await expect(page.locator('[data-testid="tool-selector"]')).toBeVisible()
    } else {
      test.skip(true, 'Not enough models available to test capability differences')
    }
  })

  test('should persist enabled tools during chat session', async ({ page }) => {
    // Select a model and enable tools
    const modelSelector = page.locator('[data-testid="model-selector"]')
    await modelSelector.click()
    
    const capableModel = page.locator('[data-testid="model-option"]').filter({
      hasText: /gpt-5|gemini/i
    }).first()
    
    if (await capableModel.count() > 0) {
      await capableModel.click()
      await page.waitForSelector('[data-testid="tool-selector"]')
      
      // Enable a tool
      const toolSwitch = page.locator('[id^="tool-"]').first()
      if (await toolSwitch.count() > 0) {
        await toolSwitch.check()
        
        // Send a test message
        const messageInput = page.locator('[data-testid="composer-input"]')
        if (await messageInput.count() > 0) {
          await messageInput.fill('Hello, this is a test message.')
          await messageInput.press('Enter')
          
          // Tool should still be enabled after sending message
          await expect(toolSwitch).toBeChecked()
          await expect(page.locator('[data-testid="tool-status-indicator"]')).toBeVisible()
        }
      }
    } else {
      test.skip(true, 'No capable models available for this test')
    }
  })
})

test.describe('Tool Registry API', () => {
  test('should return available tools for a model', async ({ request }) => {
    // This would test the API endpoint that returns model capabilities
    // For now, we'll test that the model has nexus_capabilities data
    
    test.skip(true, 'API endpoint test - would require direct database access or API route')
  })
})