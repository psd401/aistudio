import { test, expect, type Page } from '@playwright/test'

/**
 * E2E tests for the User Management feature (Issue #579, PR #580)
 *
 * Covers:
 * - Auth gating: non-admin users are redirected (always runs, no auth needed)
 * - API 401 enforcement on user management endpoints (always runs)
 * - Page structure: heading, stats cards, role tabs, filters, data table
 * - Detail sheet: open from row actions, tabs, edit mode, cancel edit
 * - Delete flow: confirmation dialog, cancel, action buttons
 * - Filter behaviour: search clears, status select, tab hides role filter
 * - Refresh button triggers data reload
 *
 * Auth note: suites marked with test.skip(!PLAYWRIGHT_AUTH_ENABLED) are skipped
 * in CI unless that env var is set with a seeded admin session.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAuthPage(url: string): boolean {
  return (
    url.includes('/auth') ||
    url.includes('/sign-in') ||
    url.includes('/login')
  )
}

async function gotoAdminUsers(page: Page): Promise<void> {
  await page.goto('/admin/users')
  await page.waitForURL(
    (url) => !isAuthPage(url.href),
    { timeout: 15_000 }
  )
  await page.locator('h1').filter({ hasText: /User Management/i }).waitFor({
    timeout: 15_000,
  })
}

async function openRowActionsMenu(page: Page, rowIndex = 0): Promise<void> {
  const row = page.locator('tbody tr').nth(rowIndex)
  const actionsBtn = row.locator('[data-testid="user-row-actions"]')
  await actionsBtn.click()
}

// ---------------------------------------------------------------------------
// Suite 1 — Auth gating (always runs)
// ---------------------------------------------------------------------------
test.describe('User Management — Auth Gating', () => {
  test('unauthenticated access to /admin/users is redirected', async ({
    page,
  }) => {
    await page.context().clearCookies()
    await page.goto('/admin/users')

    await page.waitForURL(
      (url) => isAuthPage(url.href) || url.pathname === '/',
      { timeout: 15_000 }
    )

    const finalUrl = page.url()
    expect(
      isAuthPage(finalUrl) || new URL(finalUrl).pathname === '/'
    ).toBe(true)
  })

  test('GET /api/admin/users returns 401 without auth', async ({ request }) => {
    const res = await request.get('/api/admin/users')
    expect(res.status()).toBe(401)
  })

  test('GET /api/admin/users/1 returns 401 without auth', async ({
    request,
  }) => {
    const res = await request.get('/api/admin/users/1')
    expect(res.status()).toBe(401)
  })

  test('DELETE /api/admin/users/1 returns 401 without auth', async ({
    request,
  }) => {
    const res = await request.delete('/api/admin/users/1')
    expect(res.status()).toBe(401)
  })

  test('PATCH /api/admin/users/1 returns 401 without auth', async ({
    request,
  }) => {
    const res = await request.patch('/api/admin/users/1', {
      data: { firstName: 'Test' },
    })
    expect(res.status()).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Suite 2 — Page structure (requires admin session)
// ---------------------------------------------------------------------------
test.describe('User Management — Page Structure', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await gotoAdminUsers(page)
  })

  test('page has User Management heading', async ({ page }) => {
    await expect(
      page.locator('h1').filter({ hasText: /User Management/i })
    ).toBeVisible()
  })

  test('stats cards grid renders', async ({ page }) => {
    // Either the skeleton cards or the real stats grid should appear
    const statsGrid = page.locator('[data-testid="user-stats-grid"]')
    try {
      await statsGrid.waitFor({ state: 'visible', timeout: 10_000 })
      await expect(statsGrid).toBeVisible()
    } catch {
      // Fall back to skeleton grid while data loads
      const skeletonGrid = page
        .locator('[class*="grid"]')
        .filter({ has: page.locator('[class*="Skeleton"]') })
        .first()
      await expect(skeletonGrid).toBeVisible({ timeout: 5_000 })
    }
  })

  test('role tabs render All Users, Admins, Staff, Students', async ({
    page,
  }) => {
    for (const label of ['All Users', 'Admins', 'Staff', 'Students']) {
      await expect(
        page.locator('[role="tab"]').filter({ hasText: label })
      ).toBeVisible({ timeout: 10_000 })
    }
  })

  test('"All Users" tab is selected by default', async ({ page }) => {
    await expect(
      page.locator('[role="tab"]').filter({ hasText: 'All Users' })
    ).toHaveAttribute('data-state', 'active', { timeout: 10_000 })
  })

  test('search input is present with correct placeholder', async ({ page }) => {
    const searchInput = page.locator('[aria-label="Search users"]')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })
    await expect(searchInput).toHaveAttribute(
      'placeholder',
      /Search users by name or email/i
    )
  })

  test('status filter select is visible', async ({ page }) => {
    await expect(
      page.locator('[aria-label="Filter by status"]')
    ).toBeVisible({ timeout: 10_000 })
  })

  test('role filter is visible when "All Users" tab is active', async ({
    page,
  }) => {
    await expect(
      page.locator('[aria-label="Filter by role"]')
    ).toBeVisible({ timeout: 10_000 })
  })

  test('Refresh button is visible', async ({ page }) => {
    await expect(
      page.locator('button').filter({ hasText: /Refresh/i })
    ).toBeVisible({ timeout: 10_000 })
  })

  test('data table renders with at least one row', async ({ page }) => {
    await expect(page.locator('tbody tr').first()).toBeVisible({
      timeout: 15_000,
    })
  })
})

// ---------------------------------------------------------------------------
// Suite 3 — Stats cards content (requires admin session)
// ---------------------------------------------------------------------------
test.describe('User Management — Stats Cards', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await gotoAdminUsers(page)
    // Wait for real stat cards to appear (skeleton resolves)
    await page
      .locator('[data-testid="user-stats-grid"]')
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {/* grid may still be skeletonising */})
  })

  test('Total Users stat card is visible', async ({ page }) => {
    await expect(
      page.locator('[data-testid="stat-card"][data-stat-label="Total Users"]')
    ).toBeVisible({ timeout: 10_000 })
  })

  test('Active Now stat card is visible', async ({ page }) => {
    await expect(
      page.locator('[data-testid="stat-card"][data-stat-label="Active Now"]')
    ).toBeVisible({ timeout: 10_000 })
  })

  test('Pending Invites stat card is visible', async ({ page }) => {
    await expect(
      page.locator('[data-testid="stat-card"][data-stat-label="Pending Invites"]')
    ).toBeVisible({ timeout: 10_000 })
  })

  test('Admins stat card is visible', async ({ page }) => {
    await expect(
      page.locator('[data-testid="stat-card"][data-stat-label="Admins"]')
    ).toBeVisible({ timeout: 10_000 })
  })

  test('all 4 stat cards are present', async ({ page }) => {
    await expect(page.locator('[data-testid="stat-card"]')).toHaveCount(4, {
      timeout: 10_000,
    })
  })
})

// ---------------------------------------------------------------------------
// Suite 4 — Role tab navigation (requires admin session)
// ---------------------------------------------------------------------------
test.describe('User Management — Role Tab Navigation', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await gotoAdminUsers(page)
  })

  test('clicking Admins tab makes it active', async ({ page }) => {
    const adminsTab = page.locator('[role="tab"]').filter({ hasText: 'Admins' })
    await adminsTab.click()
    await expect(adminsTab).toHaveAttribute('data-state', 'active', {
      timeout: 10_000,
    })
  })

  test('clicking Admins tab hides the role filter', async ({ page }) => {
    await page.locator('[role="tab"]').filter({ hasText: 'Admins' }).click()
    await expect(page.locator('[aria-label="Filter by role"]')).not.toBeVisible({
      timeout: 5_000,
    })
  })

  test('clicking Staff tab makes it active', async ({ page }) => {
    const staffTab = page.locator('[role="tab"]').filter({ hasText: 'Staff' })
    await staffTab.click()
    await expect(staffTab).toHaveAttribute('data-state', 'active', {
      timeout: 10_000,
    })
  })

  test('clicking Students tab makes it active', async ({ page }) => {
    const studentsTab = page.locator('[role="tab"]').filter({ hasText: 'Students' })
    await studentsTab.click()
    await expect(studentsTab).toHaveAttribute('data-state', 'active', {
      timeout: 10_000,
    })
  })

  test('returning to All Users tab restores the role filter', async ({
    page,
  }) => {
    // Navigate away
    await page.locator('[role="tab"]').filter({ hasText: 'Admins' }).click()
    // Navigate back
    const allTab = page.locator('[role="tab"]').filter({ hasText: 'All Users' })
    await allTab.click()
    await expect(allTab).toHaveAttribute('data-state', 'active', {
      timeout: 10_000,
    })
    await expect(page.locator('[aria-label="Filter by role"]')).toBeVisible({
      timeout: 5_000,
    })
  })
})

// ---------------------------------------------------------------------------
// Suite 5 — Filters (requires admin session)
// ---------------------------------------------------------------------------
test.describe('User Management — Filters', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await gotoAdminUsers(page)
  })

  test('typing in search shows the Clear Filters button', async ({ page }) => {
    await page.locator('[aria-label="Search users"]').fill('test')
    await expect(
      page.locator('[aria-label="Clear all filters"]')
    ).toBeVisible({ timeout: 5_000 })
  })

  test('Clear Filters button resets search value and hides itself', async ({
    page,
  }) => {
    const searchInput = page.locator('[aria-label="Search users"]')
    await searchInput.fill('test')

    const clearBtn = page.locator('[aria-label="Clear all filters"]')
    await clearBtn.waitFor({ state: 'visible', timeout: 5_000 })
    await clearBtn.click()

    await expect(searchInput).toHaveValue('')
    await expect(clearBtn).not.toBeVisible({ timeout: 5_000 })
  })

  test('status filter dropdown shows All Statuses, Active, Inactive, Pending', async ({
    page,
  }) => {
    await page.locator('[aria-label="Filter by status"]').click()

    for (const label of ['All Statuses', 'Active', 'Inactive', 'Pending']) {
      await expect(
        page.locator('[role="option"]').filter({ hasText: label })
      ).toBeVisible({ timeout: 5_000 })
    }

    await page.keyboard.press('Escape')
  })

  test('selecting Active status shows Clear button', async ({ page }) => {
    await page.locator('[aria-label="Filter by status"]').click()
    await page.locator('[role="option"]').filter({ hasText: 'Active' }).click()
    await expect(
      page.locator('[aria-label="Clear all filters"]')
    ).toBeVisible({ timeout: 5_000 })
  })
})

// ---------------------------------------------------------------------------
// Suite 6 — User Detail Sheet (requires admin session)
// ---------------------------------------------------------------------------
test.describe('User Management — User Detail Sheet', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await gotoAdminUsers(page)
    await page.locator('tbody tr').first().waitFor({ timeout: 15_000 })
  })

  test('View Details from row menu opens the detail dialog', async ({
    page,
  }) => {
    await openRowActionsMenu(page)
    await page.locator('[role="menuitem"]').filter({ hasText: /View Details/i }).click()
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 10_000 })
  })

  test('detail dialog shows user email address', async ({ page }) => {
    await openRowActionsMenu(page)
    await page.locator('[role="menuitem"]').filter({ hasText: /View Details/i }).click()

    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })

    // Email shown in DialogDescription (small text under the user name)
    await expect(
      dialog.locator('[class*="DialogDescription"], p').filter({ hasText: /@/i }).first()
    ).toBeVisible({ timeout: 10_000 })
  })

  test('detail dialog renders 4 tabs: Overview, Permissions, API Usage, Activity', async ({
    page,
  }) => {
    await openRowActionsMenu(page)
    await page.locator('[role="menuitem"]').filter({ hasText: /View Details/i }).click()

    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })

    for (const label of ['Overview', 'Permissions', 'API Usage', 'Activity']) {
      await expect(
        dialog.locator('[role="tab"]').filter({ hasText: label })
      ).toBeVisible({ timeout: 5_000 })
    }
  })

  test('Overview tab is active by default in detail sheet', async ({
    page,
  }) => {
    await openRowActionsMenu(page)
    await page.locator('[role="menuitem"]').filter({ hasText: /View Details/i }).click()

    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })

    await expect(
      dialog.locator('[role="tab"]').filter({ hasText: 'Overview' })
    ).toHaveAttribute('data-state', 'active', { timeout: 5_000 })
  })

  test('clicking Permissions tab makes it active', async ({ page }) => {
    await openRowActionsMenu(page)
    await page.locator('[role="menuitem"]').filter({ hasText: /View Details/i }).click()

    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })

    const permTab = dialog.locator('[role="tab"]').filter({ hasText: 'Permissions' })
    await permTab.click()
    await expect(permTab).toHaveAttribute('data-state', 'active', { timeout: 5_000 })
  })

  test('clicking Activity tab makes it active', async ({ page }) => {
    await openRowActionsMenu(page)
    await page.locator('[role="menuitem"]').filter({ hasText: /View Details/i }).click()

    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })

    const actTab = dialog.locator('[role="tab"]').filter({ hasText: 'Activity' })
    await actTab.click()
    await expect(actTab).toHaveAttribute('data-state', 'active', { timeout: 5_000 })
  })

  test('pressing Escape closes the detail dialog', async ({ page }) => {
    await openRowActionsMenu(page)
    await page.locator('[role="menuitem"]').filter({ hasText: /View Details/i }).click()

    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })

    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  })
})

// ---------------------------------------------------------------------------
// Suite 7 — Edit mode (requires admin session)
// ---------------------------------------------------------------------------
test.describe('User Management — Edit Mode', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await gotoAdminUsers(page)
    await page.locator('tbody tr').first().waitFor({ timeout: 15_000 })
  })

  async function openDetailAndEdit(page: Page): Promise<void> {
    await openRowActionsMenu(page)
    await page.locator('[role="menuitem"]').filter({ hasText: /View Details/i }).click()
    await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 10_000 })
    await page.locator('[role="dialog"] button').filter({ hasText: /^Edit$/i }).click()
  }

  test('clicking Edit shows Save and Cancel buttons', async ({ page }) => {
    await openDetailAndEdit(page)
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog.locator('button').filter({ hasText: /Save/i })).toBeVisible({ timeout: 5_000 })
    await expect(dialog.locator('button').filter({ hasText: /Cancel/i })).toBeVisible({ timeout: 5_000 })
  })

  test('firstName input is enabled in edit mode', async ({ page }) => {
    await openDetailAndEdit(page)
    await expect(page.locator('#firstName')).toBeEnabled({ timeout: 5_000 })
  })

  test('lastName input is enabled in edit mode', async ({ page }) => {
    await openDetailAndEdit(page)
    await expect(page.locator('#lastName')).toBeEnabled({ timeout: 5_000 })
  })

  test('email input stays disabled in edit mode (read-only)', async ({ page }) => {
    await openDetailAndEdit(page)
    await expect(page.locator('#email')).toBeDisabled({ timeout: 5_000 })
  })

  test('Cancel reverts to view mode and restores original value', async ({
    page,
  }) => {
    await openDetailAndEdit(page)
    const dialog = page.locator('[role="dialog"]')
    const firstNameInput = page.locator('#firstName')
    const originalValue = await firstNameInput.inputValue()

    await firstNameInput.fill('TemporaryEditValue')
    await dialog.locator('button').filter({ hasText: /Cancel/i }).click()

    // Back to view mode: Edit button visible, Save gone
    await expect(
      dialog.locator('button').filter({ hasText: /^Edit$/i })
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      dialog.locator('button').filter({ hasText: /^Save$/i })
    ).not.toBeVisible()

    // Input reverted and disabled
    await expect(firstNameInput).toHaveValue(originalValue)
    await expect(firstNameInput).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// Suite 8 — Delete flow (requires admin session)
// ---------------------------------------------------------------------------
test.describe('User Management — Delete Flow', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await gotoAdminUsers(page)
    await page.locator('tbody tr').first().waitFor({ timeout: 15_000 })
  })

  test('Delete User menu item opens confirmation dialog', async ({ page }) => {
    await openRowActionsMenu(page)
    await page.locator('[role="menuitem"]').filter({ hasText: /Delete User/i }).click()
    await expect(page.locator('[role="alertdialog"]')).toBeVisible({ timeout: 10_000 })
  })

  test('delete dialog shows "Delete User" title text', async ({ page }) => {
    await openRowActionsMenu(page)
    await page.locator('[role="menuitem"]').filter({ hasText: /Delete User/i }).click()

    const alertDialog = page.locator('[role="alertdialog"]')
    await alertDialog.waitFor({ state: 'visible', timeout: 10_000 })
    await expect(alertDialog.locator(':has-text("Delete User")')).toBeVisible()
  })

  test('delete dialog has Cancel and Delete action buttons', async ({ page }) => {
    await openRowActionsMenu(page)
    await page.locator('[role="menuitem"]').filter({ hasText: /Delete User/i }).click()

    const alertDialog = page.locator('[role="alertdialog"]')
    await alertDialog.waitFor({ state: 'visible', timeout: 10_000 })

    await expect(alertDialog.locator('button').filter({ hasText: /Cancel/i })).toBeVisible()
    await expect(alertDialog.locator('button').filter({ hasText: /Delete/i })).toBeVisible()
  })

  test('Cancel button closes dialog without removing any row', async ({
    page,
  }) => {
    const rowCountBefore = await page.locator('tbody tr').count()

    await openRowActionsMenu(page)
    await page.locator('[role="menuitem"]').filter({ hasText: /Delete User/i }).click()

    const alertDialog = page.locator('[role="alertdialog"]')
    await alertDialog.waitFor({ state: 'visible', timeout: 10_000 })

    await alertDialog.locator('button').filter({ hasText: /Cancel/i }).click()

    await expect(alertDialog).not.toBeVisible({ timeout: 5_000 })
    expect(await page.locator('tbody tr').count()).toBe(rowCountBefore)
  })
})
