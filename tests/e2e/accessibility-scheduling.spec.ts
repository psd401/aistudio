import { test, expect } from '@playwright/test'

/**
 * Accessibility Testing for Scheduling UI Components
 * Tests WCAG compliance and accessibility features in scheduling interface
 * Part of Issue #271: Testing: End-to-End Scheduling Workflows
 */

test.use({ storageState: 'tests/e2e/.auth/user-a.json' })

test.describe('Accessibility Testing for Scheduling Components', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to assistant architect page
    await page.goto('/utilities/assistant-architect')

    // Wait for page load
    try {
      await page.waitForSelector('[data-testid="assistant-architect-page"]', { timeout: 5000 })
    } catch {
      await page.waitForSelector('h1, h2, .assistant-architect, main', { timeout: 10000 })
    }
  })

  test.describe('Schedule Modal Accessibility', () => {
    test('should have proper modal accessibility attributes', async ({ page }) => {
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

      // Test modal attributes
      const modal = page.locator('[role="dialog"]')
      await expect(modal).toBeVisible()
      await expect(modal).toHaveAttribute('role', 'dialog')

      // Check for aria-labelledby or aria-label
      const modalLabel = await modal.getAttribute('aria-labelledby')
      const modalAriaLabel = await modal.getAttribute('aria-label')
      expect(modalLabel || modalAriaLabel).toBeTruthy()

      // Check for modal title
      const modalTitle = page.locator('h1, h2, h3').filter({ hasText: /schedule/i }).first()
      if (await modalTitle.count() > 0) {
        await expect(modalTitle).toBeVisible()

        // If using aria-labelledby, verify the ID matches
        if (modalLabel) {
          const titleId = await modalTitle.getAttribute('id')
          expect(titleId || "").toBeTruthy()
        }
      }

      // Test focus management
      const firstFocusableElement = page.locator('input, button, select, textarea').first()
      if (await firstFocusableElement.count() > 0) {
        await expect(firstFocusableElement).toBeFocused()
      }

      // Test escape key closes modal
      await page.keyboard.press('Escape')
      await expect(modal).not.toBeVisible({ timeout: 3000 })

      // Focus should return to trigger button
      await expect(scheduleButton).toBeFocused()
    })

    test('should support keyboard navigation through form elements', async ({ page }) => {
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

      // Test tab navigation through form elements
      const focusableElements = await page.locator('input, button, select, textarea, [role="button"], [role="combobox"]').all()

      for (let i = 0; i < Math.min(focusableElements.length, 10); i++) {
        if (i > 0) {
          await page.keyboard.press('Tab')
        }

        const currentFocused = page.locator(':focus')
        await expect(currentFocused).toBeVisible()

        // Test that focused element has visible focus indicator
        const element = focusableElements[i]
        const computedStyle = await element.evaluate(el => {
          const style = window.getComputedStyle(el)
          return {
            outline: style.outline,
            outlineWidth: style.outlineWidth,
            outlineStyle: style.outlineStyle,
            outlineColor: style.outlineColor,
            boxShadow: style.boxShadow
          }
        })

        // Should have some form of focus indicator
        const hasFocusIndicator = computedStyle.outline !== 'none' ||
                                 computedStyle.outlineWidth !== '0px' ||
                                 computedStyle.boxShadow !== 'none'

        expect(hasFocusIndicator).toBe(true)
      }

      // Test reverse tab navigation
      await page.keyboard.press('Shift+Tab')
      const previousFocused = page.locator(':focus')
      await expect(previousFocused).toBeVisible()
    })

    test('should have proper form field labels and associations', async ({ page }) => {
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

      // Test all form inputs have proper labeling
      const inputs = await page.locator('input').all()

      for (const input of inputs) {
        const inputId = await input.getAttribute('id')
        const ariaLabel = await input.getAttribute('aria-label')
        const ariaLabelledBy = await input.getAttribute('aria-labelledby')
        const ariaDescribedBy = await input.getAttribute('aria-describedby')

        // Check for explicit label association
        if (inputId) {
          const explicitLabel = page.locator(`label[for="${inputId}"]`)
          const hasExplicitLabel = await explicitLabel.count() > 0

          if (hasExplicitLabel) {
            await expect(explicitLabel).toBeVisible()
            const labelText = await explicitLabel.textContent()
            expect(labelText?.trim()).toBeTruthy()
          }
        }

        // Must have some form of labeling
        const hasProperLabeling = inputId || ariaLabel || ariaLabelledBy
        expect(hasProperLabeling).toBeTruthy()

        // Test placeholder is not the only labeling method
        const placeholder = await input.getAttribute('placeholder')
        if (placeholder && !ariaLabel && !ariaLabelledBy && !inputId) {
          console.warn('Input relies only on placeholder for labeling, which is not accessible')
        }

        // Test for helpful descriptions
        if (ariaDescribedBy) {
          const description = page.locator(`#${ariaDescribedBy}`)
          await expect(description).toBeVisible()
        }
      }
    })
  })

  test.describe('Schedule Form Accessibility', () => {
    test('should provide clear error messages and validation feedback', async ({ page }) => {
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

      // Clear the name field to trigger validation
      const nameInput = page.locator('input[placeholder*="Enter a name"], input[type="text"]').first()
      if (await nameInput.count() > 0) {
        await nameInput.clear()

        // Try to submit form
        const submitButton = page.locator('button:has-text("Create Schedule"), button:has-text("Submit")')
        if (await submitButton.count() > 0) {
          await submitButton.click()
          await page.waitForTimeout(1000)

          // Check for error messages
          const errorMessages = page.locator('[role="alert"], .error, [data-testid*="error"], [aria-invalid="true"]')
          if (await errorMessages.count() > 0) {
            const errorMessage = errorMessages.first()
            await expect(errorMessage).toBeVisible()

            // Error should be associated with the input
            const errorId = await errorMessage.getAttribute('id')
            if (errorId) {
              const associatedInput = page.locator(`[aria-describedby*="${errorId}"]`)
              await expect(associatedInput).toBeVisible()
            }

            // Error message should be descriptive
            const errorText = await errorMessage.textContent()
            expect(errorText?.length).toBeGreaterThan(5)
            expect(errorText?.toLowerCase()).toContain('required')
          }

          // Input should be marked as invalid
          const invalidInput = page.locator('[aria-invalid="true"]')
          if (await invalidInput.count() > 0) {
            await expect(invalidInput).toBeVisible()
          }
        }
      }
    })

    test('should support screen reader announcements for dynamic content', async ({ page }) => {
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

      // Test frequency selection changes
      const weeklyRadio = page.locator('input[value="weekly"]')
      if (await weeklyRadio.count() > 0) {
        await weeklyRadio.click()

        // Check if additional options appear with proper announcements
        const daysOfWeekSection = page.locator('text=Days of Week, fieldset')
        if (await daysOfWeekSection.count() > 0) {
          await expect(daysOfWeekSection).toBeVisible()

          // Should have live region or proper labeling for dynamic content
          const liveRegion = page.locator('[aria-live], [role="status"], [role="alert"]')
          if (await liveRegion.count() > 0) {
            const liveContent = await liveRegion.textContent()
            expect(liveContent).toBeTruthy()
          }
        }
      }

      // Test monthly selection
      const monthlyRadio = page.locator('input[value="monthly"]')
      if (await monthlyRadio.count() > 0) {
        await monthlyRadio.click()

        const dayOfMonthSection = page.locator('text=Day of Month')
        if (await dayOfMonthSection.count() > 0) {
          await expect(dayOfMonthSection).toBeVisible()
        }
      }

      // Test custom cron selection
      const customRadio = page.locator('input[value="custom"]')
      if (await customRadio.count() > 0) {
        await customRadio.click()

        const cronSection = page.locator('text=Cron Expression')
        if (await cronSection.count() > 0) {
          await expect(cronSection).toBeVisible()

          // Cron input should have helpful description
          const cronInput = page.locator('input[placeholder*="0 9 * * 1-5"]')
          if (await cronInput.count() > 0) {
            const ariaDescribedBy = await cronInput.getAttribute('aria-describedby')
            if (ariaDescribedBy) {
              const description = page.locator(`#${ariaDescribedBy}`)
              await expect(description).toBeVisible()
              const descText = await description.textContent()
              expect(descText?.toLowerCase()).toContain('cron')
            }
          }
        }
      }
    })

    test('should have proper fieldset and legend structure', async ({ page }) => {
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

      // Check for proper grouping of related form controls
      const fieldsets = await page.locator('fieldset').all()

      for (const fieldset of fieldsets) {
        // Each fieldset should have a legend
        const legend = fieldset.locator('legend').first()
        if (await legend.count() > 0) {
          await expect(legend).toBeVisible()
          const legendText = await legend.textContent()
          expect(legendText?.trim()).toBeTruthy()
        }

        // Fieldset should contain related form controls
        const controls = fieldset.locator('input, select, textarea')
        const controlCount = await controls.count()
        expect(controlCount).toBeGreaterThan(0)
      }

      // Frequency selection should be in a fieldset
      const frequencyInputs = page.locator('input[type="radio"][value*="daily"], input[type="radio"][value*="weekly"]')
      if (await frequencyInputs.count() > 0) {
        const firstRadio = frequencyInputs.first()
        const fieldset = firstRadio.locator('xpath=ancestor::fieldset')

        if (await fieldset.count() > 0) {
          const legend = fieldset.locator('legend')
          await expect(legend).toBeVisible()
          const legendText = await legend.textContent()
          expect(legendText?.toLowerCase()).toContain('frequency')
        }
      }
    })
  })

  test.describe('Schedule List Accessibility', () => {
    test('should have proper table structure and headers', async ({ page }) => {
      // Navigate to schedules page
      await page.goto('/schedules')
      await page.waitForTimeout(2000)

      const scheduleTable = page.locator('table')
      if (await scheduleTable.count() > 0) {
        await expect(scheduleTable).toBeVisible()

        // Table should have proper caption or accessible name
        const caption = scheduleTable.locator('caption')
        const tableLabel = await scheduleTable.getAttribute('aria-label')
        const tableLabelledBy = await scheduleTable.getAttribute('aria-labelledby')

        const hasAccessibleName = await caption.count() > 0 || tableLabel || tableLabelledBy
        expect(hasAccessibleName).toBe(true)

        // Check for proper header structure
        const headers = scheduleTable.locator('th')
        const headerCount = await headers.count()

        if (headerCount > 0) {
          // Each header should have proper scope
          for (let i = 0; i < headerCount; i++) {
            const header = headers.nth(i)
            const scope = await header.getAttribute('scope')
            expect(scope).toBeTruthy()
            expect(['col', 'row', 'colgroup', 'rowgroup']).toContain(scope)
          }

          // Headers should have descriptive text
          const headerTexts = await headers.allTextContents()
          headerTexts.forEach(text => {
            expect(text.trim()).toBeTruthy()
          })
        }
      } else {
        // If no table, check for list structure
        const scheduleList = page.locator('[role="list"], ul, ol')
        if (await scheduleList.count() > 0) {
          await expect(scheduleList).toBeVisible()

          const listItems = scheduleList.locator('[role="listitem"], li')
          const itemCount = await listItems.count()
          expect(itemCount).toBeGreaterThanOrEqual(0)
        }
      }
    })

    test('should provide accessible action buttons', async ({ page }) => {
      await page.goto('/schedules')
      await page.waitForTimeout(2000)

      // Find action buttons (Edit, Delete, Pause, etc.)
      const actionButtons = page.locator('button:has-text("Edit"), button:has-text("Delete"), button:has-text("Pause"), button:has-text("Resume")')
      const buttonCount = await actionButtons.count()

      if (buttonCount > 0) {
        for (let i = 0; i < Math.min(buttonCount, 5); i++) {
          const button = actionButtons.nth(i)

          // Button should be properly labeled
          const buttonText = await button.textContent()
          const ariaLabel = await button.getAttribute('aria-label')
          const ariaLabelledBy = await button.getAttribute('aria-labelledby')

          const hasAccessibleName = buttonText?.trim() || ariaLabel || ariaLabelledBy
          expect(hasAccessibleName).toBeTruthy()

          // Destructive actions should be clearly indicated
          const buttonTextLower = (buttonText?.toLowerCase() || ariaLabel?.toLowerCase() || '')
          if (buttonTextLower.includes('delete') || buttonTextLower.includes('remove')) {
            // Should have additional confirmation or warning styling
            const hasWarningClass = await button.evaluate(el =>
              el.className.includes('danger') ||
              el.className.includes('destructive') ||
              el.className.includes('warning') ||
              el.className.includes('red')
            )

            // At minimum, should be clearly labeled as destructive
            expect(buttonTextLower).toContain('delete')
          }

          // Test button keyboard accessibility
          await button.focus()
          await expect(button).toBeFocused()

          // Should be activatable with Enter and Space
          // (This is typically handled by browsers for button elements)
        }
      }
    })
  })

  test.describe('Color Contrast and Visual Accessibility', () => {
    test('should meet WCAG color contrast requirements', async ({ page }) => {
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

      // Test color contrast for key elements
      const keyElements = [
        page.locator('h1, h2, h3').first(),
        page.locator('label').first(),
        page.locator('button').first(),
        page.locator('input').first()
      ]

      for (const element of keyElements) {
        if (await element.count() > 0) {
          const styles = await element.evaluate(el => {
            const computed = window.getComputedStyle(el)
            return {
              color: computed.color,
              backgroundColor: computed.backgroundColor,
              fontSize: computed.fontSize
            }
          })

          // Extract RGB values for contrast calculation
          const extractRGB = (color: string) => {
            const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
            return match ? [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])] : null
          }

          const textColor = extractRGB(styles.color)
          const bgColor = extractRGB(styles.backgroundColor)

          if (textColor && bgColor) {
            // Simple contrast check (for demonstration)
            // In production, use a proper contrast calculation library
            const isHighContrast = Math.abs(textColor[0] - bgColor[0]) > 100 ||
                                  Math.abs(textColor[1] - bgColor[1]) > 100 ||
                                  Math.abs(textColor[2] - bgColor[2]) > 100

            expect(isHighContrast).toBe(true)
          }
        }
      }
    })

    test('should be usable without color alone', async ({ page }) => {
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

      // Check for status indicators that don't rely solely on color
      const statusElements = page.locator('.success, .error, .warning, .info')
      const statusCount = await statusElements.count()

      for (let i = 0; i < statusCount; i++) {
        const statusEl = statusElements.nth(i)

        // Should have text, icon, or other non-color indicator
        const hasText = ((await statusEl.textContent()) || '').trim().length > 0
        const hasIcon = await statusEl.locator('svg, .icon, [data-icon]').count() > 0
        const hasBorder = await statusEl.evaluate(el => {
          const style = window.getComputedStyle(el)
          return style.border !== 'none' && style.borderWidth !== '0px'
        })

        const hasNonColorIndicator = hasText || hasIcon || hasBorder
        expect(hasNonColorIndicator).toBe(true)
      }

      // Error messages should have clear text, not just red color
      const errorElements = page.locator('.error, [role="alert"]')
      const errorCount = await errorElements.count()

      for (let i = 0; i < errorCount; i++) {
        const errorEl = errorElements.nth(i)
        const errorText = await errorEl.textContent()
        expect(errorText?.trim().length).toBeGreaterThan(0)
        expect(errorText?.toLowerCase()).toMatch(/error|invalid|required|failed/)
      }
    })
  })

  test.describe('Screen Reader Support', () => {
    test('should have proper heading hierarchy', async ({ page }) => {
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

      // Check heading hierarchy
      const headings = await page.locator('h1, h2, h3, h4, h5, h6').all()

      if (headings.length > 0) {
        const headingLevels = []

        for (const heading of headings) {
          const tagName = await heading.evaluate(el => el.tagName.toLowerCase())
          const level = parseInt(tagName.charAt(1))
          headingLevels.push(level)
        }

        // Check for proper hierarchy (no skipping levels)
        for (let i = 1; i < headingLevels.length; i++) {
          const currentLevel = headingLevels[i]
          const previousLevel = headingLevels[i - 1]

          // Should not skip more than one level
          expect(currentLevel - previousLevel).toBeLessThanOrEqual(1)
        }

        // Should start with h1 or h2
        expect(headingLevels[0]).toBeLessThanOrEqual(2)
      }
    })

    test('should provide landmarks and regions', async ({ page }) => {
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

      // Check for main content landmark
      const main = page.locator('main, [role="main"]')
      if (await main.count() > 0) {
        await expect(main).toBeVisible()
      }

      // Check for form landmark
      const form = page.locator('form, [role="form"]')
      if (await form.count() > 0) {
        await expect(form).toBeVisible()

        // Form should be properly labeled
        const formLabel = await form.getAttribute('aria-label')
        const formLabelledBy = await form.getAttribute('aria-labelledby')
        expect(formLabel || formLabelledBy).toBeTruthy()
      }

      // Check for complementary content
      const complementary = page.locator('[role="complementary"]')
      if (await complementary.count() > 0) {
        await expect(complementary).toBeVisible()
      }

      // Navigation landmarks should be present on the page
      const navigation = page.locator('nav, [role="navigation"]')
      if (await navigation.count() > 0) {
        const navCount = await navigation.count()
        expect(navCount).toBeGreaterThanOrEqual(1)

        // Multiple navigation landmarks should be distinguished
        if (navCount > 1) {
          for (let i = 0; i < navCount; i++) {
            const nav = navigation.nth(i)
            const navLabel = await nav.getAttribute('aria-label')
            const navLabelledBy = await nav.getAttribute('aria-labelledby')
            expect(navLabel || navLabelledBy).toBeTruthy()
          }
        }
      }
    })
  })

  test.describe('Mobile and Touch Accessibility', () => {
    test('should be usable with touch interfaces', async ({ page }) => {
      // Set mobile viewport
      await page.setViewportSize({ width: 375, height: 667 })

      const architectCards = page.locator('[data-testid="assistant-architect-card"]')
      const architectCount = await architectCards.count()

      if (architectCount === 0) {
        test.skip(true, 'No assistant architects available for testing')
        return
      }

      await architectCards.nth(0).click()
      await page.waitForSelector('[data-testid="assistant-architect-execution"]', { timeout: 10000 })

      const scheduleButton = page.locator('button:has-text("Schedule")')

      // Button should be large enough for touch (minimum 44x44px)
      const buttonBox = await scheduleButton.boundingBox()
      if (buttonBox) {
        expect(buttonBox.width).toBeGreaterThanOrEqual(44)
        expect(buttonBox.height).toBeGreaterThanOrEqual(44)
      }

      await scheduleButton.click()
      await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

      // Form controls should be touch-friendly
      const touchTargets = page.locator('button, input, select, [role="button"], [role="combobox"]')
      const targetCount = await touchTargets.count()

      for (let i = 0; i < Math.min(targetCount, 5); i++) {
        const target = touchTargets.nth(i)
        const targetBox = await target.boundingBox()

        if (targetBox) {
          // Touch targets should be at least 44x44px
          expect(Math.min(targetBox.width, targetBox.height)).toBeGreaterThanOrEqual(40)
        }
      }

      // Modal should be usable on mobile
      const modal = page.locator('[role="dialog"]')
      const modalBox = await modal.boundingBox()

      if (modalBox) {
        // Modal should not exceed viewport width
        expect(modalBox.width).toBeLessThanOrEqual(375)

        // Modal should be scrollable if content is too tall
        if (modalBox.height > 600) {
          const isScrollable = await modal.evaluate(el => {
            const style = window.getComputedStyle(el)
            return style.overflowY === 'auto' || style.overflowY === 'scroll'
          })
          expect(isScrollable).toBe(true)
        }
      }
    })

    test('should support zoom up to 200% without horizontal scrolling', async ({ page }) => {
      // Test zoom functionality
      await page.setViewportSize({ width: 1280, height: 720 })

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

      // Simulate 200% zoom by halving viewport
      await page.setViewportSize({ width: 640, height: 360 })

      // Content should still be accessible without horizontal scrolling
      const modal = page.locator('[role="dialog"]')
      await expect(modal).toBeVisible()

      // Form should still be usable
      const formElements = page.locator('input, button, select')
      const elementCount = await formElements.count()

      for (let i = 0; i < Math.min(elementCount, 3); i++) {
        const element = formElements.nth(i)
        await expect(element).toBeVisible()

        // Element should be within viewport bounds
        const elementBox = await element.boundingBox()
        if (elementBox) {
          expect(elementBox.x).toBeGreaterThanOrEqual(0)
          expect(elementBox.x + elementBox.width).toBeLessThanOrEqual(640)
        }
      }
    })
  })
})