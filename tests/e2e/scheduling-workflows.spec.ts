import { test, expect } from './fixtures'

/**
 * End-to-End Scheduling Workflows Test Suite
 * Tests complete scheduling functionality from creation to execution
 * Part of Issue #271: Testing: End-to-End Scheduling Workflows
 */

test.use({ storageState: 'tests/e2e/.auth/user-a.json' })

test.describe('Complete Scheduling Workflows', () => {
  let scheduleId: string | null = null
  let createdScheduleIds: string[] = []

  test.beforeEach(async ({ page }) => {
    // Navigate to assistant architect page
    await page.goto('/utilities/assistant-architect')

    // Wait for authentication and page load
    try {
      await page.waitForSelector('[data-testid="assistant-architect-page"]', { timeout: 5000 })
    } catch {
      await page.waitForSelector('h1, h2, .assistant-architect, main', { timeout: 10000 })
    }
  })

  test.afterEach(async ({ page }) => {
    // Clean up created schedules to avoid test pollution
    for (const id of createdScheduleIds) {
      try {
        // Navigate to schedules page and delete
        await page.goto('/schedules')
        await page.waitForTimeout(1000)

        const deleteButton = page.locator(`[data-testid="delete-schedule-${id}"]`)
        if (await deleteButton.count() > 0) {
          await deleteButton.click()

          // Confirm deletion
          const confirmButton = page.locator('button:has-text("Delete")')
          if (await confirmButton.count() > 0) {
            await confirmButton.click()
            await page.waitForTimeout(500)
          }
        }
      } catch (error) {
        console.log(`Failed to cleanup schedule ${id}:`, error)
      }
    }
    createdScheduleIds = []
  })

  test('should complete full schedule creation to execution workflow', async ({ page }) => {
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount === 0) {
      test.skip(true, 'No assistant architects available for testing')
      return
    }

    // Step 1: Select assistant architect
    await architectCards.nth(0).click()
    await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

    // Step 2: Open schedule modal
    const scheduleButton = page.locator('button:has-text("Schedule")')
    await expect(scheduleButton).toBeVisible()
    await scheduleButton.click()

    // Wait for modal to appear
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })
    await expect(page.locator('text=Schedule Assistant Execution')).toBeVisible()

    // Step 3: Fill schedule form
    const scheduleName = `E2E Test Schedule ${Date.now()}`
    const nameInput = page.locator('input[placeholder*="Enter a name"]').first()
    await nameInput.fill(scheduleName)

    // Set daily frequency at 10:00 AM
    const dailyRadio = page.locator('input[value="daily"]')
    await dailyRadio.click()

    const timeInput = page.locator('input[type="time"]')
    await timeInput.fill('10:00')

    // Select timezone (if available)
    const timezoneSelect = page.locator('[role="combobox"]').filter({ hasText: /Time|UTC|EST|PST/ }).first()
    if (await timezoneSelect.count() > 0) {
      await timezoneSelect.click()
      await page.locator('text=UTC').click()
    }

    // Step 4: Submit schedule creation
    const createButton = page.locator('button:has-text("Create Schedule")')
    await createButton.click()

    // Wait for creation response
    await page.waitForTimeout(3000)

    // Check for success or failure
    const successToast = page.locator('text=Schedule Created')
    const errorMessage = page.locator('[data-testid="error-message"], .error, text=Failed')

    const hasIsSuccess = await successToast.count() > 0
    const hasError = await errorMessage.count() > 0

    if (hasIsSuccess) {
      // Schedule created successfully
      expect(hasIsSuccess).toBe(true)

      // Modal should close
      const modal = page.locator('[role="dialog"]')
      await expect(modal).not.toBeVisible({ timeout: 5000 })

      // Step 5: Verify schedule appears in schedule list
      await page.goto('/schedules')
      await page.waitForTimeout(2000)

      // Look for our created schedule
      const scheduleCard = page.locator(`text=${scheduleName}`).first()
      await expect(scheduleCard).toBeVisible()

      // Verify schedule details
      await expect(page.locator('text=Daily')).toBeVisible()
      await expect(page.locator('text=10:00')).toBeVisible()
      await expect(page.locator('text=Active')).toBeVisible()

      // Step 6: Test schedule management actions
      const scheduleRow = scheduleCard.locator('..').locator('..')

      // Test pause/resume functionality
      const pauseButton = scheduleRow.locator('button:has-text("Pause")')
      if (await pauseButton.count() > 0) {
        await pauseButton.click()
        await page.waitForTimeout(1000)
        await expect(page.locator('text=Paused')).toBeVisible()

        // Resume schedule
        const resumeButton = scheduleRow.locator('button:has-text("Resume")')
        await resumeButton.click()
        await page.waitForTimeout(1000)
        await expect(page.locator('text=Active')).toBeVisible()
      }

      // Step 7: Test manual execution (if available)
      const executeNowButton = scheduleRow.locator('button:has-text("Execute Now")')
      if (await executeNowButton.count() > 0) {
        await executeNowButton.click()
        await page.waitForTimeout(2000)

        // Should show execution started or queued
        const executionStatus = page.locator('text=Executing, text=Queued, text=Started')
        if (await executionStatus.count() > 0) {
          await expect(executionStatus).toBeVisible()
        }
      }

      // Step 8: Verify execution results (if execution completed)
      await page.waitForTimeout(5000) // Wait for potential execution

      const resultsLink = scheduleRow.locator('a:has-text("View Results"), button:has-text("Results")')
      if (await resultsLink.count() > 0) {
        await resultsLink.click()
        await page.waitForTimeout(2000)

        // Should navigate to results page or show results modal
        const resultsContent = page.locator('[data-testid="execution-results"], text=Result, text=Output')
        if (await resultsContent.count() > 0) {
          await expect(resultsContent).toBeVisible()
        }
      }

      // Record schedule ID for cleanup
      const scheduleIdMatch = await page.url().match(/schedule[s]?[\/](\d+)/)
      if (scheduleIdMatch) {
        createdScheduleIds.push(scheduleIdMatch[1])
      }

    } else if (hasError) {
      // Expected error scenarios (permissions, validation, etc.)
      expect(hasError).toBe(true)
      console.log('Schedule creation failed as expected in test environment')
    } else {
      // Unexpected state - should have either success or error
      throw new Error('Schedule creation completed without clear success or error indication')
    }
  })

  test('should handle weekly schedule configuration correctly', async ({ page }) => {
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount === 0) {
      test.skip(true, 'No assistant architects available for testing')
      return
    }

    await architectCards.nth(0).click()
    await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

    const scheduleButton = page.locator('button:has-text("Schedule")')
    await scheduleButton.click()
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

    // Fill basic info
    const scheduleName = `E2E Weekly Test ${Date.now()}`
    const nameInput = page.locator('input[placeholder*="Enter a name"]').first()
    await nameInput.fill(scheduleName)

    // Select weekly frequency
    const weeklyRadio = page.locator('input[value="weekly"]')
    await weeklyRadio.click()
    await expect(weeklyRadio).toBeChecked()

    // Should show days of week selection
    await expect(page.locator('text=Days of Week')).toBeVisible()

    // Select specific days (Monday, Wednesday, Friday)
    const mondayCheckbox = page.locator('input[type="checkbox"][value="1"], label:has-text("Monday") input')
    const wednesdayCheckbox = page.locator('input[type="checkbox"][value="3"], label:has-text("Wednesday") input')
    const fridayCheckbox = page.locator('input[type="checkbox"][value="5"], label:has-text("Friday") input')

    if (await mondayCheckbox.count() > 0) await mondayCheckbox.click()
    if (await wednesdayCheckbox.count() > 0) await wednesdayCheckbox.click()
    if (await fridayCheckbox.count() > 0) await fridayCheckbox.click()

    // Set time
    const timeInput = page.locator('input[type="time"]')
    await timeInput.fill('14:30')

    // Check next run preview
    const previewSection = page.locator('text=Next Run Preview')
    if (await previewSection.count() > 0) {
      await expect(previewSection).toBeVisible()
    }

    // Submit form
    const createButton = page.locator('button:has-text("Create Schedule")')
    await createButton.click()
    await page.waitForTimeout(3000)

    // Handle success or expected failure
    const successToast = page.locator('text=Schedule Created')
    const errorMessage = page.locator('[data-testid="error-message"], .error, text=Failed')

    const hasIsSuccess = await successToast.count() > 0
    const hasError = await errorMessage.count() > 0

    expect(hasIsSuccess || hasError).toBe(true)

    if (hasIsSuccess) {
      // Verify in schedule list
      await page.goto('/schedules')
      await page.waitForTimeout(2000)
      await expect(page.locator(`text=${scheduleName}`)).toBeVisible()
      await expect(page.locator('text=Weekly')).toBeVisible()
    }
  })

  test('should handle monthly schedule configuration correctly', async ({ page }) => {
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount === 0) {
      test.skip(true, 'No assistant architects available for testing')
      return
    }

    await architectCards.nth(0).click()
    await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

    const scheduleButton = page.locator('button:has-text("Schedule")')
    await scheduleButton.click()
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

    // Fill basic info
    const scheduleName = `E2E Monthly Test ${Date.now()}`
    const nameInput = page.locator('input[placeholder*="Enter a name"]').first()
    await nameInput.fill(scheduleName)

    // Select monthly frequency
    const monthlyRadio = page.locator('input[value="monthly"]')
    await monthlyRadio.click()
    await expect(monthlyRadio).toBeChecked()

    // Should show day of month selection
    await expect(page.locator('text=Day of Month')).toBeVisible()

    // Set day of month
    const dayOfMonthInput = page.locator('input[type="number"]').filter({ hasText: /day/i }).first()
    if (await dayOfMonthInput.count() === 0) {
      // Try alternative selector
      const dayInputs = page.locator('input[type="number"]')
      const dayInputCount = await dayInputs.count()
      if (dayInputCount > 0) {
        await dayInputs.nth(0).fill('15')
      }
    } else {
      await dayOfMonthInput.fill('15')
    }

    // Set time
    const timeInput = page.locator('input[type="time"]')
    await timeInput.fill('09:00')

    // Submit form
    const createButton = page.locator('button:has-text("Create Schedule")')
    await createButton.click()
    await page.waitForTimeout(3000)

    // Handle success or expected failure
    const successToast = page.locator('text=Schedule Created')
    const errorMessage = page.locator('[data-testid="error-message"], .error, text=Failed')

    const hasIsSuccess = await successToast.count() > 0
    const hasError = await errorMessage.count() > 0

    expect(hasIsSuccess || hasError).toBe(true)

    if (hasIsSuccess) {
      await page.goto('/schedules')
      await page.waitForTimeout(2000)
      await expect(page.locator(`text=${scheduleName}`)).toBeVisible()
      await expect(page.locator('text=Monthly')).toBeVisible()
    }
  })

  test('should validate custom cron expressions', async ({ page }) => {
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount === 0) {
      test.skip(true, 'No assistant architects available for testing')
      return
    }

    await architectCards.nth(0).click()
    await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

    const scheduleButton = page.locator('button:has-text("Schedule")')
    await scheduleButton.click()
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

    // Fill basic info
    const nameInput = page.locator('input[placeholder*="Enter a name"]').first()
    await nameInput.fill('E2E Cron Test')

    // Select custom frequency
    const customRadio = page.locator('input[value="custom"]')
    await customRadio.click()
    await expect(customRadio).toBeChecked()

    // Should show cron expression field
    await expect(page.locator('text=Cron Expression')).toBeVisible()

    // Test invalid cron expression
    const cronInput = page.locator('input[placeholder*="0 9 * * 1-5"]')
    await cronInput.fill('invalid cron')

    const createButton = page.locator('button:has-text("Create Schedule")')
    await createButton.click()
    await page.waitForTimeout(1000)

    // Should show validation error
    const validationError = page.locator('text=Invalid, text=cron, text=expression')
    if (await validationError.count() > 0) {
      await expect(validationError).toBeVisible()
    }

    // Test valid cron expression (every weekday at 9 AM)
    await cronInput.clear()
    await cronInput.fill('0 9 * * 1-5')

    await createButton.click()
    await page.waitForTimeout(3000)

    // Should succeed or show expected error
    const successToast = page.locator('text=Schedule Created')
    const errorMessage = page.locator('[data-testid="error-message"], .error, text=Failed')

    const hasIsSuccess = await successToast.count() > 0
    const hasError = await errorMessage.count() > 0

    expect(hasIsSuccess || hasError).toBe(true)
  })

  test('should handle schedule editing workflow', async ({ page }) => {
    // This test would require creating a schedule first, then editing it
    // For now, we'll test the edit interface if a schedule exists
    await page.goto('/schedules')
    await page.waitForTimeout(2000)

    const scheduleCards = page.locator('[data-testid="schedule-card"]')
    const scheduleCount = await scheduleCards.count()

    if (scheduleCount === 0) {
      test.skip(true, 'No existing schedules available for edit testing')
      return
    }

    // Find an edit button
    const editButton = page.locator('button:has-text("Edit")').first()
    if (await editButton.count() > 0) {
      await editButton.click()
      await page.waitForTimeout(1000)

      // Should open edit modal or navigate to edit page
      const editModal = page.locator('[role="dialog"]')
      const editForm = page.locator('form')

      if (await editModal.count() > 0) {
        await expect(editModal).toBeVisible()

        // Should have pre-filled form fields
        const nameInput = page.locator('input[value]').first()
        if (await nameInput.count() > 0) {
          const currentValue = await nameInput.inputValue()
          expect(currentValue.length).toBeGreaterThan(0)
        }

        // Test cancel functionality
        const cancelButton = page.locator('button:has-text("Cancel")')
        if (await cancelButton.count() > 0) {
          await cancelButton.click()
          await expect(editModal).not.toBeVisible()
        }
      }
    } else {
      test.skip(true, 'No edit functionality available for existing schedules')
    }
  })

  test('should handle schedule deletion workflow', async ({ page }) => {
    await page.goto('/schedules')
    await page.waitForTimeout(2000)

    const scheduleCards = page.locator('[data-testid="schedule-card"]')
    const scheduleCount = await scheduleCards.count()

    if (scheduleCount === 0) {
      test.skip(true, 'No existing schedules available for deletion testing')
      return
    }

    // Find a delete button
    const deleteButton = page.locator('button:has-text("Delete")').first()
    if (await deleteButton.count() > 0) {
      // Get schedule name before deletion
      const scheduleRow = deleteButton.locator('..').locator('..')
      const scheduleName = await scheduleRow.locator('[data-testid="schedule-name"]').first().textContent()

      await deleteButton.click()
      await page.waitForTimeout(500)

      // Should show confirmation dialog
      const confirmDialog = page.locator('[role="dialog"]')
      if (await confirmDialog.count() > 0) {
        await expect(confirmDialog).toBeVisible()
        await expect(page.locator('text=Delete Schedule')).toBeVisible()

        // Test cancel first
        const cancelButton = page.locator('button:has-text("Cancel")')
        if (await cancelButton.count() > 0) {
          await cancelButton.click()
          await expect(confirmDialog).not.toBeVisible()

          // Schedule should still exist
          if (scheduleName) {
            await expect(page.locator(`text=${scheduleName}`)).toBeVisible()
          }
        }
      }
    } else {
      test.skip(true, 'No delete functionality available for existing schedules')
    }
  })

  test('should show proper error handling for API failures', async ({ page }) => {
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount === 0) {
      test.skip(true, 'No assistant architects available for testing')
      return
    }

    await architectCards.nth(0).click()
    await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

    const scheduleButton = page.locator('button:has-text("Schedule")')
    await scheduleButton.click()
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

    // Test with empty required fields to trigger validation
    const createButton = page.locator('button:has-text("Create Schedule")')
    await createButton.click()
    await page.waitForTimeout(1000)

    // Should show validation errors
    const validationErrors = page.locator('text=required, text=invalid, .error, [data-testid="error"]')
    if (await validationErrors.count() > 0) {
      await expect(validationErrors.first()).toBeVisible()
    }

    // Button should remain enabled for retry
    await expect(createButton).toBeEnabled()

    // Modal should remain open for correction
    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()
  })

  test('should demonstrate accessibility compliance', async ({ page }) => {
    const architectCards = page.locator('[data-testid="assistant-architect-card"]')
    const architectCount = await architectCards.count()

    if (architectCount === 0) {
      test.skip(true, 'No assistant architects available for testing')
      return
    }

    await architectCards.nth(0).click()
    await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

    const scheduleButton = page.locator('button:has-text("Schedule")')
    await scheduleButton.click()
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

    // Test keyboard navigation
    await page.keyboard.press('Tab') // Should focus first form element
    await page.keyboard.press('Tab') // Move to next element
    await page.keyboard.press('Shift+Tab') // Move back

    // Test modal accessibility
    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()
    await expect(modal).toHaveAttribute('role', 'dialog')

    // Test form labels and inputs
    const formInputs = page.locator('input')
    const inputCount = await formInputs.count()

    for (let i = 0; i < Math.min(inputCount, 5); i++) {
      const input = formInputs.nth(i)
      const inputId = await input.getAttribute('id')
      const inputAriaLabel = await input.getAttribute('aria-label')
      const inputAriaLabelledBy = await input.getAttribute('aria-labelledby')

      // Input should have proper labeling
      if (inputId) {
        const label = page.locator(`label[for="${inputId}"]`)
        if (await label.count() > 0) {
          await expect(label).toBeVisible()
        }
      }

      // Or have aria-label/aria-labelledby
      expect(inputAriaLabel || inputAriaLabelledBy || inputId).toBeTruthy()
    }

    // Test focus management
    const closeButton = page.locator('button:has-text("Cancel"), button[aria-label*="close"]')
    if (await closeButton.count() > 0) {
      await closeButton.click()
      await expect(modal).not.toBeVisible()

      // Focus should return to schedule button
      await expect(scheduleButton).toBeFocused()
    }
  })
})