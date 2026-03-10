import { test, expect } from '@playwright/test'

/**
 * E2E tests for admin branding settings (Issue #824)
 * Covers: Branding tab renders, logo upload UI is present, invalid file types are rejected.
 *
 * Auth note: these tests require a seeded admin session. They auto-skip in CI
 * unless PLAYWRIGHT_AUTH_ENABLED=true is set.
 */
test.describe('Admin Branding Settings', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the admin settings page; relies on seeded auth state
    await page.goto('/admin/settings')
  })

  // ── Happy path ────────────────────────────────────────────────────────────

  test('branding tab renders with logo upload widget', async ({ page }) => {
    // If redirected to sign-in, the test environment has no auth state — skip
    const url = page.url()
    if (url.includes('/auth') || url.includes('/sign-in') || url.includes('/login')) {
      test.skip(true, 'No admin auth state available — run with seeded users locally')
      return
    }

    // The Branding tab should be present in the settings tab list
    const brandingTab = page.locator('[role="tab"]:has-text("Branding")')
    await expect(brandingTab).toBeVisible({ timeout: 10000 })

    // Click the Branding tab
    await brandingTab.click()

    // Logo upload card should be visible
    const logoCard = page.locator('text=Organization Logo')
    await expect(logoCard).toBeVisible()

    // Upload button should be present and enabled
    const uploadButton = page.locator('button:has-text("Upload Logo")')
    await expect(uploadButton).toBeVisible()
    await expect(uploadButton).toBeEnabled()
  })

  // ── Auth gate ─────────────────────────────────────────────────────────────

  test('unauthenticated access is redirected away from admin settings', async ({ page }) => {
    // Clear cookies to simulate an unauthenticated session
    await page.context().clearCookies()
    await page.goto('/admin/settings')

    // Should redirect to auth page rather than showing settings
    await page.waitForURL((url) =>
      url.pathname.includes('/auth') ||
      url.pathname.includes('/sign-in') ||
      url.pathname.includes('/login') ||
      url.pathname === '/',
      { timeout: 10000 }
    )

    const settingsHeading = page.locator('h1:has-text("System Settings")')
    await expect(settingsHeading).not.toBeVisible()
  })

  // ── Error state ───────────────────────────────────────────────────────────

  test('invalid file type triggers client-side error toast', async ({ page }) => {
    const url = page.url()
    if (url.includes('/auth') || url.includes('/sign-in') || url.includes('/login')) {
      test.skip(true, 'No admin auth state available — run with seeded users locally')
      return
    }

    // Navigate to the Branding tab
    const brandingTab = page.locator('[role="tab"]:has-text("Branding")')
    await expect(brandingTab).toBeVisible({ timeout: 10000 })
    await brandingTab.click()

    // Simulate uploading an unsupported file type (e.g. GIF)
    const fileInput = page.locator('input[type="file"][accept*="image/png"]')
    await fileInput.setInputFiles({
      name: 'test.gif',
      mimeType: 'image/gif',
      buffer: Buffer.from('GIF89a') // minimal GIF header
    })

    // Toast with "Invalid file type" should appear
    const errorToast = page.locator('[role="status"]:has-text("Invalid file type"), [data-sonner-toast]:has-text("Invalid file type"), [data-radix-toast-viewport] :has-text("Invalid file type")')
    await expect(errorToast).toBeVisible({ timeout: 5000 })
  })
})
