import { test, expect } from './fixtures'
import { authenticateContext } from './helpers/session-auth'

// Authenticated functional spec: skip when no minted session, and inject the
// session cookie before every test (was missing — the suite ran unauthenticated
// and every test redirected to sign-in). See docs/guides/e2e-authenticated-testing.md.
test.skip(
  !process.env.PLAYWRIGHT_AUTH_ENABLED,
  'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true'
)
test.beforeEach(async ({ page }) => {
  await authenticateContext(page.context())
})

test.describe('Model Compare Polling Migration', () => {
  test.beforeEach(async ({ page }) => {
    // Go to compare page
    await page.goto('/compare')
    
    // Wait for page load
    await page.waitForSelector('h1:has-text("Model Comparison")', { timeout: 10000 })
  })

  test('should display model comparison interface', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Model Comparison')
    // Two model selectors (comboboxes, by aria-label), the prompt textbox, and the
    // submit control. The UI uses aria-label/role, not data-testid hooks.
    await expect(page.getByRole('combobox', { name: /Select first model/i })).toBeVisible()
    await expect(page.getByRole('combobox', { name: /Select second model/i })).toBeVisible()
    await expect(page.getByRole('textbox', { name: /Comparison prompt/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Submit comparison/i })).toBeVisible()
  })

  test('requires a prompt before submitting (submit disabled until filled)', async ({ page }) => {
    // Two chat models auto-select; with an empty prompt the submit control stays
    // disabled (the UI gates via disabled state, not an error toast).
    await page.route('/api/models', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            { id: 1, modelId: 'gpt-4o', name: 'GPT-4o', provider: 'openai', active: true, nexusEnabled: false, capabilities: '["chat"]' },
            { id: 2, modelId: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'bedrock', active: true, nexusEnabled: false, capabilities: '["chat"]' },
          ],
        }),
      })
    )
    await page.goto('/compare')
    await page.waitForSelector('h1:has-text("Model Comparison")', { timeout: 10000 })
    const submit = page.getByRole('button', { name: /Submit comparison/i })
    await expect(submit).toBeDisabled()
    await page.getByRole('textbox', { name: /Comparison prompt/i }).fill('Compare these')
    await expect(submit).toBeEnabled()
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

  // FIXME: the warning-TOAST bug this caught is now FIXED in product (model-compare
  // switched to the mounted sonner toaster — the shadcn `useToast` it used has no
  // mounted <Toaster>, so its toasts never rendered). But the mocked-SSE flow itself
  // (route('/api/compare') -> response.body.getReader() stream -> per-model event
  // routing) does not complete in-test under the host dev server — model1 content
  // never renders — so these assertions can't pass yet. Needs a browser trace to see
  // why the mocked stream isn't read. Marked fixme (known-broken) rather than faked.
  test.fixme('SSE warning event shows unavailable toast and does not leave spinner running', async ({ page }) => {
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

    await page.getByRole('textbox', { name: /Comparison prompt/i }).fill('Test prompt')
    const compareButton = page.getByRole('button', { name: /Submit comparison/i })

    // With mocked model data the button should be enabled once both selectors are populated.
    // If not enabled (e.g. auth redirected, selector UI changed), fail explicitly.
    await expect(compareButton).toBeEnabled({ timeout: 5000 })
    await compareButton.click()

    // Warning toast should appear. Target the toast TEXT — `[role="alert"]` also
    // matches Next's empty __next-route-announcer__, which would mask the toast.
    await expect(page.getByText(/unavailable/i).first()).toBeVisible({ timeout: 5000 })

    // Model1 content should render
    await expect(page.locator('text=Hello from model 1')).toBeVisible({ timeout: 5000 })

    // No streaming spinner should remain visible after both models complete
    await expect(page.locator('[data-testid="streaming-indicator"]')).not.toBeVisible({ timeout: 5000 })
  })
})
