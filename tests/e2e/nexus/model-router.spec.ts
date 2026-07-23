import { test, expect, type Page } from '../fixtures'
import { authenticateContext } from '../helpers/session-auth'
import { gotoNexus, sendMessage } from './utils'

/**
 * Deterministic E2E coverage for the Nexus model-router experience.
 *
 * These tests intercept the outbound chat request after the real authenticated
 * UI constructs it. They therefore cover browser state → transport wiring without
 * spending provider tokens or depending on Bedrock/OpenAI/Google availability.
 * Router selection itself is exhaustively covered by the model-router unit suite.
 * This file deliberately does not match Playwright's live-provider exclusion regex.
 */

const ROUTER_EMAIL = 'staff@example.com'
const ROUTER_SUB = 'e2e-staff-user'

interface CapturedChatBody {
  messages: Array<Record<string, unknown>>
  modelId: string
  nexusMode: 'standard' | 'advanced'
  modelFamily: 'auto' | 'openai' | 'anthropic' | 'google'
  enabledTools?: string[]
  enabledConnectors?: string[]
}

const MOCK_CHAT_STREAM = [
  'data: {"type":"start","messageId":"e2e-router-assistant"}\n\n',
  'data: {"type":"text-start","id":"e2e-router-text"}\n\n',
  'data: {"type":"text-delta","id":"e2e-router-text","delta":"ok"}\n\n',
  'data: {"type":"text-end","id":"e2e-router-text"}\n\n',
  'data: {"type":"finish","finishReason":"stop"}\n\n',
  'data: [DONE]\n\n',
].join('')

async function installChatCapture(page: Page): Promise<{ body: Promise<CapturedChatBody> }> {
  let resolveBody: (body: CapturedChatBody) => void = () => undefined
  let rejectBody: (error: Error) => void = () => undefined
  const body = new Promise<CapturedChatBody>((resolve, reject) => {
    resolveBody = resolve
    rejectBody = reject
  })

  await page.route('**/api/nexus/chat', async route => {
    try {
      const requestBody = route.request().postDataJSON() as CapturedChatBody
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'x-vercel-ai-ui-message-stream': 'v1',
        },
        body: MOCK_CHAT_STREAM,
      })
      resolveBody(requestBody)
    } catch (error) {
      rejectBody(error instanceof Error ? error : new Error(String(error)))
    }
  }, { times: 1 })

  return { body }
}

async function selectStandard(page: Page): Promise<void> {
  const routing = page.getByRole('button', { name: 'Nexus routing mode' })
  await routing.click()
  await page.getByTestId('nexus-mode-standard').click()
  await expect(routing).toContainText('Standard')
}

async function selectFamily(
  page: Page,
  family: Exclude<CapturedChatBody['modelFamily'], 'auto'>,
  label: string
): Promise<void> {
  const routing = page.getByRole('button', { name: 'Nexus routing mode' })
  await routing.click()
  await page.getByTestId('nexus-mode-advanced').click()
  await page.getByTestId(`nexus-family-${family}`).click()
  await expect(routing).toContainText(`Advanced · ${label}`)
}

async function capturePrompt(page: Page, prompt: string): Promise<CapturedChatBody> {
  const capture = await installChatCapture(page)
  await sendMessage(page, prompt)
  return capture.body
}

test.describe('Nexus model router — authenticated deterministic UI and wire contract', () => {
  // Every test uses the dedicated staff identity. The local seed clears only this
  // identity's Nexus preference so the first test proves the fresh-user default.
  test.describe.configure({ mode: 'serial' })
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires the authenticated host dev server; no external AI provider is used'
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context(), ROUTER_EMAIL, ROUTER_SUB)
    await gotoNexus(page)
  })

  test('a freshly seeded user starts in Standard with no exact-model or manual-tool controls', async ({ page }) => {
    const routing = page.getByRole('button', { name: 'Nexus routing mode' })
    await expect(routing).toContainText('Standard')
    await expect(page.getByRole('button', { name: /Select AI model/i })).toHaveCount(0)
    await expect(page.getByTestId('nexus-tools-control')).toHaveCount(0)
    await expect(page.getByTestId('nexus-skills-control')).toHaveCount(0)
    await expect(page.getByTestId('nexus-mcp-control')).toHaveCount(0)
  })

  test('the first routing menu shows only Standard and Advanced, then Advanced flies out to three families', async ({ page }) => {
    const routing = page.getByRole('button', { name: 'Nexus routing mode' })
    await routing.click()
    await expect(page.getByTestId('nexus-mode-standard')).toBeVisible()
    await expect(page.getByTestId('nexus-mode-advanced')).toBeVisible()
    await expect(page.getByTestId('nexus-family-openai')).toHaveCount(0)
    await page.getByTestId('nexus-mode-advanced').click()
    await expect(page.getByTestId('nexus-family-openai')).toContainText('ChatGPT')
    await expect(page.getByTestId('nexus-family-anthropic')).toContainText('Claude')
    await expect(page.getByTestId('nexus-family-google')).toContainText('Gemini')
    await expect(page.getByTestId('nexus-family-auto')).toHaveCount(0)
    await page.getByTestId('nexus-family-anthropic').click()

    await expect(routing).toContainText('Advanced · Claude')
    await expect(page.getByRole('button', { name: /Select AI model/i })).toHaveCount(0)
    await expect(page.getByTestId('nexus-tools-control')).toBeVisible()
    await expect(page.getByTestId('nexus-skills-control')).toBeVisible()
    await expect(page.getByTestId('nexus-skills-control')).toBeDisabled()
    await expect(page.getByTestId('nexus-mcp-control')).toBeVisible()
  })

  test('the chat API rejects unsupported router modes and families before execution', async ({ page }) => {
    const statuses = await page.evaluate(async () => {
      const body = {
        messages: [{ id: 'router-validation', role: 'user', content: 'hello' }],
        modelId: 'gpt-4o-mini',
      }
      const [badMode, badFamily, advancedAuto] = await Promise.all([
        fetch('/api/nexus/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, nexusMode: 'expert' }),
        }),
        fetch('/api/nexus/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, nexusMode: 'advanced', modelFamily: 'other' }),
        }),
        fetch('/api/nexus/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, nexusMode: 'advanced', modelFamily: 'auto' }),
        }),
      ])
      return [badMode.status, badFamily.status, advancedAuto.status]
    })
    expect(statuses).toEqual([400, 400, 400])
  })

  test('Standard sends the canonical standard/auto wire contract and clears manual selections', async ({ page }) => {
    await selectFamily(page, 'anthropic', 'Claude')
    await selectStandard(page)

    const body = await capturePrompt(page, 'Explain photosynthesis briefly')
    expect(body.nexusMode).toBe('standard')
    expect(body.modelFamily).toBe('auto')
    expect(body.enabledTools ?? []).toEqual([])
    expect(body.enabledConnectors ?? []).toEqual([])
    expect(body.modelId.length).toBeGreaterThan(0)
  })

  for (const option of [
    { family: 'openai', label: 'ChatGPT' },
    { family: 'anthropic', label: 'Claude' },
    { family: 'google', label: 'Gemini' },
  ] as const) {
    test(`Advanced ${option.label} sends family=${option.family} without an exact-model choice`, async ({ page }) => {
      await selectFamily(page, option.family, option.label)
      const body = await capturePrompt(page, `Wire contract for ${option.label}`)

      expect(body.nexusMode).toBe('advanced')
      expect(body.modelFamily).toBe(option.family)
      expect(body.modelId.length).toBeGreaterThan(0)
      await expect(page.getByRole('button', { name: /Select AI model/i })).toHaveCount(0)
    })
  }

  test('saved Advanced family and Standard mode both survive navigation and reload', async ({ page }) => {
    await page.goto('/settings')
    await page.getByRole('tab', { name: 'Preferences' }).click()
    await page.getByTestId('nexus-preference-advanced').click()
    await page.getByTestId('nexus-preference-family-anthropic').click()
    await page.getByTestId('nexus-preference-save').click()
    await expect(page.getByText('Nexus preferences saved')).toBeVisible()

    await gotoNexus(page)
    const routing = page.getByRole('button', { name: 'Nexus routing mode' })
    await expect(routing).toContainText('Claude')

    const standardSave = page.waitForResponse(response =>
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/nexus'
      && response.request().headers()['next-action'] !== undefined
    )
    await selectStandard(page)
    await standardSave
    await page.reload()
    await page.waitForSelector('[data-testid="nexus-shell"]')
    await expect(page.getByRole('button', { name: 'Nexus routing mode' })).toContainText('Standard')
  })

  test('an image request goes through Standard without an image-model button', async ({ page }) => {
    await selectStandard(page)
    const prompt = 'Create an image of a friendly owl reading a book'
    const body = await capturePrompt(page, prompt)

    expect(body.nexusMode).toBe('standard')
    expect(body.modelFamily).toBe('auto')
    expect(JSON.stringify(body.messages.at(-1))).toContain(prompt)
    await expect(page.getByRole('button', { name: /Select AI model/i })).toHaveCount(0)
  })

  test('a PSD-data request goes through Standard without a manual MCP selection', async ({ page }) => {
    await selectStandard(page)
    const prompt = 'Show me attendance data for ninth grade students'
    const body = await capturePrompt(page, prompt)

    expect(body.nexusMode).toBe('standard')
    expect(body.modelFamily).toBe('auto')
    expect(body.enabledConnectors ?? []).toEqual([])
    expect(JSON.stringify(body.messages.at(-1))).toContain(prompt)
    await expect(page.getByTestId('nexus-mcp-control')).toHaveCount(0)
  })

  test('a current-information request goes through Standard without a manual web-search selection', async ({ page }) => {
    await selectStandard(page)
    const prompt = 'Search the web for the latest weather forecast in Tacoma'
    const body = await capturePrompt(page, prompt)

    expect(body.nexusMode).toBe('standard')
    expect(body.modelFamily).toBe('auto')
    expect(body.enabledTools ?? []).toEqual([])
    expect(JSON.stringify(body.messages.at(-1))).toContain(prompt)
    await expect(page.getByTestId('nexus-tools-control')).toHaveCount(0)
  })
})
