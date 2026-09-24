import { test, expect } from './fixtures'
import { authenticateContext } from './helpers/session-auth'
import { mkdirSync } from 'node:fs'

/**
 * Named flow: `assistant-architect-create-add-field` (Issue #1697 / FS#164138).
 *
 * The defect this pins: on /utilities/assistant-architect/create the reporter
 * could select a model but "Add Field" and "Continue" did nothing at all. The
 * icon (`imagePath`) is required, but a blocked submit reported itself only
 * through a toast that was never rendered — `components/ui/use-toast` wrote to
 * an unmounted shadcn Toaster while the layout mounts sonner's — and through a
 * `setFocus` that had no ref to land on. No toast, no scroll, no focus, no
 * loading state: an apparently dead button.
 *
 * What is asserted here:
 *  - with the icon deliberately left unset, Add Field and Continue each produce
 *    VISIBLE feedback (a toast naming the reason, focus + aria-invalid on the
 *    icon grid, an inline message) and do not navigate;
 *  - closing the Advanced model-family dropdown does not leave the page
 *    unclickable (the secondary `pointer-events: none` portal-leak theory from
 *    the triage brief);
 *  - once an icon is chosen, Add Field opens the field editor and Continue
 *    advances to the prompts step.
 */

const SHOT_DIR = '.verification/assistant-architect-create-add-field'

test.describe('Assistant Architect create — Add Field / Continue', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires the authenticated local E2E harness'
  )

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true })
  })

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  test('a blocked submit is visible, and a complete one advances', async ({ page }) => {
    await page.goto('/utilities/assistant-architect/create')

    const iconGrid = page.getByTestId('assistant-icon-grid')
    await expect(iconGrid).toBeVisible()
    // The requirement is discoverable before anything is clicked.
    await expect(page.getByText('Pick an icon — required before you can continue.')).toBeVisible()

    // Let the lazy next/image icons finish loading, so the evidence
    // screenshots show the real grid rather than empty placeholders.
    await page.waitForFunction(
      () => {
        const grid = document.querySelector('[data-testid="assistant-icon-grid"]')
        if (!grid) return false
        const imgs = Array.from(grid.querySelectorAll('img'))
        return imgs.length > 0 && imgs.slice(0, 12).every(img => img.complete)
      },
      undefined,
      { timeout: 30_000 }
    )

    await page.getByPlaceholder('Enter assistant name...').fill(`FS164138 ${Date.now()}`)
    await page
      .getByPlaceholder('Enter assistant description...')
      .fill('Reproduction of the frozen create flow.')

    // ── Reproduce the reporter's path: pick a model family first. ───────────
    await page.getByTestId('assistant-routing-advanced').click()
    const familyTrigger = page.getByTestId('assistant-routing-family')
    await expect(familyTrigger).toBeVisible()
    await familyTrigger.click()
    await page.getByRole('option', { name: /Claude/ }).first().click()
    await expect(familyTrigger).toContainText('Claude')

    // Secondary theory from triage: a Radix Select portal that fails to clean
    // up leaves the body inert, which would make EVERY button unclickable.
    const bodyInert = await page.evaluate(() => ({
      pointerEvents: getComputedStyle(document.body).pointerEvents,
      scrollLocked: document.body.hasAttribute('data-scroll-locked'),
    }))
    expect(bodyInert.pointerEvents).not.toBe('none')
    expect(bodyInert.scrollLocked).toBe(false)

    // ── Add Field with no icon: blocked, but VISIBLY so. ────────────────────
    await page.getByRole('button', { name: /Add Field/ }).click()

    // `.first()`: an earlier blocked click's toast may still be on screen.
    const toast = page
      .locator('[data-sonner-toast]')
      .filter({ hasText: 'Cannot continue' })
      .first()
    await expect(toast).toBeVisible()
    await expect(toast).toContainText('Please select an image for your assistant.')
    // Captured here, while the toast is still on screen — it auto-dismisses.
    // The toast is grabbed as an element shot because it lives in a fixed
    // overlay that a viewport capture of the scrolled page does not include.
    await toast.screenshot({ path: `${SHOT_DIR}/01-blocked-submit-toast.png` })
    await page.screenshot({ path: `${SHOT_DIR}/02-blocked-submit-field.png`, fullPage: false })

    await expect(iconGrid).toHaveAttribute('aria-invalid', 'true')
    await expect(iconGrid).toBeFocused()
    // Scoped to the field's own FormMessage — the same copy is in the toast.
    await expect(
      page
        .locator('p[id$="-form-item-message"]')
        .filter({ hasText: 'Please select an image for your assistant.' })
    ).toBeVisible()
    // Blocked means blocked: no field editor, still on the create page.
    await expect(page.getByPlaceholder('e.g., goal, email')).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe('/utilities/assistant-architect/create')

    // ── Continue is blocked the same way, not silently. ─────────────────────
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'Cannot continue' }).first()
    ).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/utilities/assistant-architect/create')

    // ── Choose the icon; Add Field now opens the editor. ────────────────────
    await page.locator('[aria-label^="Select "][aria-label$=" as assistant icon"]').first().click()
    await expect(iconGrid).toHaveAttribute('aria-invalid', 'false')

    await page.getByRole('button', { name: /Add Field/ }).click()
    await expect(page.getByPlaceholder('e.g., goal, email')).toBeVisible()
    await page.screenshot({ path: `${SHOT_DIR}/03-add-field-editor-opens.png`, fullPage: false })

    // ── Continue now advances to the prompts step. ──────────────────────────
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForURL(/\/utilities\/assistant-architect\/\d+\/edit\/prompts/, { timeout: 30_000 })
    await page.screenshot({ path: `${SHOT_DIR}/04-continue-advances.png`, fullPage: false })
  })
})
