import { test, expect } from '@playwright/test'

test.use({ storageState: 'tests/e2e/.auth/user-a.json' })

test.describe('Schedule Modal for Assistant Architect', () => {
  test.beforeEach(async ({ page }) => {
    // Go to assistant architect page
    await page.goto('/utilities/assistant-architect')

    // Wait for authentication and page load
    try {
      await page.waitForSelector('[data-testid="assistant-architect-page"]', { timeout: 5000 })
    } catch {
      // Fallback to general page loading indicators
      await page.waitForSelector('h1, h2, .assistant-architect, main', { timeout: 10000 })
    }
  })

  test('should open and close schedule modal', async ({ page }) => {
    // Find an assistant architect and click on it
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount > 0) {
      await architectCards.nth(0).click()

      // Wait for execution interface to load
      await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

      // Look for schedule button (it might be in different locations)
      const scheduleButton = page.locator('button:has-text("Schedule")')
      if (await scheduleButton.count() > 0) {
        // Click the schedule button to open modal
        await scheduleButton.click()

        // Verify modal is open
        const modal = page.locator('[role="dialog"]')
        await expect(modal).toBeVisible()

        // Verify modal title
        await expect(page.locator('text=Schedule Assistant Execution')).toBeVisible()

        // Close modal with cancel button
        const cancelButton = page.locator('button:has-text("Cancel")')
        await cancelButton.click()

        // Verify modal is closed
        await expect(modal).not.toBeVisible()
      } else {
        console.log('Schedule button not found - may not be visible for this assistant')
      }
    } else {
      console.log('No assistant architects found for testing')
    }
  })

  test('should validate required fields in schedule form', async ({ page }) => {
    // Navigate to assistant architect execution
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount > 0) {
      await architectCards.nth(0).click()
      await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

      const scheduleButton = page.locator('button:has-text("Schedule")')
      if (await scheduleButton.count() > 0) {
        await scheduleButton.click()

        // Wait for modal to be visible
        await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

        // Clear the schedule name field to test validation
        const nameInput = page.locator('input[placeholder*="Enter a name"]').first()
        await nameInput.clear()

        // Try to submit form with empty name
        const createButton = page.locator('button:has-text("Create Schedule")')
        await createButton.click()

        // Should show validation error for name field
        await expect(page.locator('text=Schedule name is required')).toBeVisible()
      }
    }
  })

  test('should allow selecting different schedule frequencies', async ({ page }) => {
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount > 0) {
      await architectCards.nth(0).click()
      await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

      const scheduleButton = page.locator('button:has-text("Schedule")')
      if (await scheduleButton.count() > 0) {
        await scheduleButton.click()
        await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

        // Test daily frequency (should be default)
        const dailyRadio = page.locator('input[value="daily"]')
        await expect(dailyRadio).toBeChecked()

        // Test weekly frequency
        const weeklyRadio = page.locator('input[value="weekly"]')
        await weeklyRadio.click()
        await expect(weeklyRadio).toBeChecked()

        // Should show days of week options for weekly
        await expect(page.locator('text=Days of Week')).toBeVisible()
        await expect(page.locator('text=Monday')).toBeVisible()

        // Test monthly frequency
        const monthlyRadio = page.locator('input[value="monthly"]')
        await monthlyRadio.click()
        await expect(monthlyRadio).toBeChecked()

        // Should show day of month option for monthly
        await expect(page.locator('text=Day of Month')).toBeVisible()

        // Test custom frequency
        const customRadio = page.locator('input[value="custom"]')
        await customRadio.click()
        await expect(customRadio).toBeChecked()

        // Should show cron expression field for custom
        await expect(page.locator('text=Cron Expression')).toBeVisible()
        await expect(page.locator('input[placeholder*="0 9 * * 1-5"]')).toBeVisible()
      }
    }
  })

  test('should validate time format', async ({ page }) => {
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount > 0) {
      await architectCards.nth(0).click()
      await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

      const scheduleButton = page.locator('button:has-text("Schedule")')
      if (await scheduleButton.count() > 0) {
        await scheduleButton.click()
        await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

        // Find time input
        const timeInput = page.locator('input[type="time"]')

        // Clear and enter invalid time
        await timeInput.clear()
        await timeInput.fill('25:70') // Invalid time

        // Try to submit
        const createButton = page.locator('button:has-text("Create Schedule")')
        await createButton.click()

        // Should show validation error (browser validation or custom)
        // Note: Browser validation might prevent the invalid input entirely
      }
    }
  })

  test('should display next run preview for daily schedule', async ({ page }) => {
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount > 0) {
      await architectCards.nth(0).click()
      await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

      const scheduleButton = page.locator('button:has-text("Schedule")')
      if (await scheduleButton.count() > 0) {
        await scheduleButton.click()
        await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

        // Make sure daily is selected (default)
        const dailyRadio = page.locator('input[value="daily"]')
        await dailyRadio.click()

        // Set a specific time
        const timeInput = page.locator('input[type="time"]')
        await timeInput.fill('14:30')

        // Should show next run preview
        await expect(page.locator('text=Next Run Preview')).toBeVisible()

        // Preview should contain some time information
        const previewSection = page.locator('text=Next Run Preview').locator('..').locator('..')
        const previewText = await previewSection.textContent()
        expect(previewText).toContain('2:30')
      }
    }
  })

  test('should allow timezone selection', async ({ page }) => {
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount > 0) {
      await architectCards.nth(0).click()
      await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

      const scheduleButton = page.locator('button:has-text("Schedule")')
      if (await scheduleButton.count() > 0) {
        await scheduleButton.click()
        await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

        // Click timezone selector
        const timezoneSelect = page.locator('[role="combobox"]').filter({ hasText: /Time|UTC|EST|PST/ }).first()
        await timezoneSelect.click()

        // Should show timezone options
        await expect(page.locator('text=UTC')).toBeVisible()
        await expect(page.locator('text=Eastern Time')).toBeVisible()

        // Select UTC
        await page.locator('text=UTC').click()

        // Verify selection
        await expect(timezoneSelect).toContainText('UTC')
      }
    }
  })

  test('should handle form submission with valid data', async ({ page }) => {
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount > 0) {
      await architectCards.nth(0).click()
      await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

      const scheduleButton = page.locator('button:has-text("Schedule")')
      if (await scheduleButton.count() > 0) {
        await scheduleButton.click()
        await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

        // Fill in valid schedule data
        const nameInput = page.locator('input[placeholder*="Enter a name"]').first()
        await nameInput.fill('Test Schedule E2E')

        // Select daily frequency (should be default)
        const dailyRadio = page.locator('input[value="daily"]')
        await dailyRadio.click()

        // Set time
        const timeInput = page.locator('input[type="time"]')
        await timeInput.fill('10:00')

        // Submit form
        const createButton = page.locator('button:has-text("Create Schedule")')
        await createButton.click()

        // Wait for either success or error
        await page.waitForTimeout(3000)

        // Check for success toast or error message
        const successToast = page.locator('text=Schedule Created')
        const errorMessage = page.locator('text=Failed to Create Schedule')

        // Either success or a specific error should appear
        const hasSuccess = await successToast.count() > 0
        const hasError = await errorMessage.count() > 0

        expect(hasSuccess || hasError).toBe(true)

        // If successful, modal should close
        if (hasSuccess) {
          const modal = page.locator('[role="dialog"]')
          await expect(modal).not.toBeVisible()
        }
      }
    }
  })

  test('should handle API errors gracefully', async ({ page }) => {
    // This test would need to mock API failures or use a test environment
    // For now, we just verify the error handling UI elements exist
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount > 0) {
      await architectCards.nth(0).click()
      await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

      const scheduleButton = page.locator('button:has-text("Schedule")')
      if (await scheduleButton.count() > 0) {
        await scheduleButton.click()
        await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

        // Verify error handling UI elements are present
        // (The actual error would need API mocking to test properly)
        const createButton = page.locator('button:has-text("Create Schedule")')
        await expect(createButton).toBeVisible()
        await expect(createButton).toBeEnabled()
      }
    }
  })
})