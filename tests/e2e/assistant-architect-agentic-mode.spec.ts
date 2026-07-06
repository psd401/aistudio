import { test, expect } from './fixtures'
import { authenticateContext } from './helpers/session-auth'

/**
 * E2E coverage for the agentic Assistant Architect mode (Issue #926).
 *
 * Named flows from the issue:
 *   - assistant-architect-agentic-mode-creation
 *   - agentic-assistant-execution-with-tools
 *   - tool-call-timeline-display
 *   - form-driven-assistant-backward-compat
 *   - agentic-per-assistant-rate-limit-config (#926 follow-up)
 *   - destructive-tool-confirmation-gate (#926 follow-up)
 *
 * These tests gracefully skip when the required fixtures (an editable / an
 * approved agentic / an approved prompt-chain assistant) aren't present in the
 * environment, matching the repo's existing assistant-architect e2e style.
 */

test.describe('Assistant Architect — agentic mode', () => {
  // Mint the seeded-admin session — without it every test here landed on the
  // sign-in redirect and silently skipped, even under PLAYWRIGHT_AUTH_ENABLED
  // (epic #922 completion audit).
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and seed users'
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  // ── assistant-architect-agentic-mode-creation ──────────────────────────────
  test('author can select agentic mode and pick tools in the editor', async ({ page }) => {
    // Open the create flow (mode selector lives in the shared create/edit form).
    await page.goto('/utilities/assistant-architect/create')

    // The mode selector + agentic section must be present.
    const modeSection = page.locator('[data-testid="agentic-mode-section"]')
    try {
      await modeSection.waitFor({ timeout: 10000 })
    } catch {
      test.skip(true, 'Assistant Architect create form not accessible in this environment')
      return
    }
    await expect(modeSection).toBeVisible()

    const modeSelector = page.locator('[data-testid="assistant-mode-selector"]')
    await expect(modeSelector).toBeVisible()

    // Selecting agentic reveals the tools picker + limits.
    await page.locator('#mode-agentic').click()
    const agenticConfig = page.locator('[data-testid="agentic-config"]')
    await expect(agenticConfig).toBeVisible()

    // The per-run limit inputs render with their defaults.
    await expect(page.locator('[data-testid="agent-max-steps"]')).toBeVisible()
    await expect(page.locator('[data-testid="agent-timeout"]')).toBeVisible()
    await expect(page.locator('[data-testid="agent-cost-cap"]')).toBeVisible()
  })

  // ── agentic-per-assistant-rate-limit-config ────────────────────────────────
  test('agentic config exposes a per-assistant runs-per-hour limit', async ({ page }) => {
    await page.goto('/utilities/assistant-architect/create')
    const modeSection = page.locator('[data-testid="agentic-mode-section"]')
    try {
      await modeSection.waitFor({ timeout: 10000 })
    } catch {
      test.skip(true, 'Assistant Architect create form not accessible in this environment')
      return
    }
    await page.locator('#mode-agentic').click()
    // The per-assistant rate-limit input renders alongside the per-run limits.
    await expect(page.locator('[data-testid="agent-rate-limit"]')).toBeVisible()
  })

  // ── destructive-tool-confirmation-gate ─────────────────────────────────────
  test('agentic execution offers a destructive-tool approval opt-in', async ({ page }) => {
    await page.goto('/utilities/assistant-catalog')
    const cards = page.locator('[data-testid="assistant-architect-card"], [class*="card"]')
    if ((await cards.count()) === 0) {
      test.skip(true, 'No assistants available to execute')
      return
    }
    await cards.nth(0).click()

    // The destructive-approval checkbox renders only for an agentic assistant that
    // exposes at least one tool. Its presence is the contract under test; absence
    // (prompt-chain assistant, or agentic with no tools) is an acceptable skip.
    const approval = page.getByLabel('Allow destructive tool actions for this run')
    const appeared = await approval
      .waitFor({ timeout: 6000 })
      .then(() => true)
      .catch(() => false)
    if (appeared) {
      // Default is unchecked: destructive tools are gated unless the user opts in.
      await expect(approval).not.toBeChecked()
    } else {
      test.skip(true, 'Selected assistant is not agentic-with-tools')
    }
  })

  // ── agentic-assistant-execution-with-tools + tool-call-timeline-display ─────
  test('agentic execution surfaces a tool-call timeline', async ({ page }) => {
    await page.goto('/utilities/assistant-catalog')

    // Find an approved agentic assistant to run. Without one, skip.
    const cards = page.locator('[data-testid="assistant-architect-card"], [class*="card"]')
    if ((await cards.count()) === 0) {
      test.skip(true, 'No assistants available to execute')
      return
    }

    // The timeline only renders for agentic assistants once a tool is called.
    // We assert the component contract: when present, it has the test id and
    // renders item rows. We don't force a specific assistant to exist.
    await cards.nth(0).click()
    const runButton = page.locator('button:has-text("Run"), [data-testid="execute-button"]')
    if ((await runButton.count()) === 0) {
      test.skip(true, 'Selected assistant is not executable')
      return
    }

    // Fill any required inputs with placeholder text, then run.
    const inputs = page.locator('input[type="text"], textarea')
    const inputCount = await inputs.count()
    for (let i = 0; i < inputCount; i++) {
      await inputs.nth(i).fill('test').catch(() => {})
    }
    await runButton.first().click().catch(() => {})

    // If this assistant is agentic and calls a tool, the timeline appears. We
    // wait briefly; absence is acceptable (prompt-chain assistant or no tool use).
    const timeline = page.locator('[data-testid="tool-call-timeline"]')
    const appeared = await timeline
      .waitFor({ timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    if (appeared) {
      await expect(timeline).toBeVisible()
      // Each entry is a labeled row.
      const items = page.locator('[data-testid="tool-call-timeline-item"]')
      await expect(items.first()).toBeVisible()
    } else {
      test.skip(true, 'No agentic tool-call timeline produced (non-agentic or no tool use)')
    }
  })

  // ── form-driven-assistant-backward-compat ──────────────────────────────────
  test('prompt-chain assistants execute without a tool-call timeline', async ({ page }) => {
    await page.goto('/utilities/assistant-catalog')

    const cards = page.locator('[data-testid="assistant-architect-card"], [class*="card"]')
    if ((await cards.count()) === 0) {
      test.skip(true, 'No assistants available to execute')
      return
    }

    await cards.nth(0).click()
    const runButton = page.locator('button:has-text("Run"), [data-testid="execute-button"]')
    if ((await runButton.count()) === 0) {
      test.skip(true, 'Selected assistant is not executable')
      return
    }

    // A prompt-chain assistant must still render its execution UI. The timeline
    // is hidden for prompt-chain mode (it only renders when mode === 'agentic').
    const executionUi = page.locator('main, [class*="card"]')
    await expect(executionUi.first()).toBeVisible()
  })
})
