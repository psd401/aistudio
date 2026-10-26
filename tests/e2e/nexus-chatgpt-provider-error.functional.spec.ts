import postgres from 'postgres'
import { test, expect, type Page } from './fixtures'
import { authenticateContext } from './helpers/session-auth'
import {
  getConversationIdFromUrl,
  gotoNexus,
  sendMessage,
  waitForStreamingComplete,
} from './nexus/utils'
import {
  PROVIDER_NOT_CONFIGURED_CODE,
  PROVIDER_NOT_CONFIGURED_MESSAGE,
} from '@/app/api/nexus/chat/configuration-error-response'

/**
 * FS#167798 / #1849 — "Every time I try and use ChatGPT I get 'An Error
 * Occurred'". The OpenAI provider's key was missing, the adapter threw
 * SYS_CONFIGURATION_ERROR, and the route collapsed it into the generic 500
 * "Failed to process chat request".
 *
 * 1. Error path (client contract): the route's 503 PROVIDER_NOT_CONFIGURED body
 *    is served at the network boundary and the UI must show a distinct,
 *    actionable "Model unavailable" message. The body is served by `page.route`
 *    because the local router excludes unconfigured providers from routed
 *    selection, so a real turn cannot reach that error deterministically. The
 *    server half (SYS_CONFIGURATION_ERROR -> this exact body, checked before the
 *    generic 500) is pinned by
 *    app/api/nexus/chat/__tests__/configuration-error-response.test.ts.
 *
 * 2. Success path (live): Advanced -> ChatGPT answers on a Bedrock-hosted GPT
 *    model, which is how ChatGPT is served since #1960. Needs live Bedrock
 *    credentials, so it is gated on E2E_RUN_EXTERNAL=1.
 */

const GPT_MODEL_ID = 'us.openai.gpt-6-luna'
const GPT_MODEL_NAME = 'GPT-6 Luna (ChatGPT E2E)'

function createDatabase() {
  return postgres(
    process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/aistudio',
    { ssl: process.env.E2E_DB_SSL === 'true' },
  )
}

async function chooseAdvancedChatGPT(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Nexus routing mode' }).click()
  await page.getByTestId('nexus-mode-advanced').click()
  await page.getByTestId('nexus-family-openai').click()
  await expect(page.getByRole('button', { name: 'Nexus routing mode' })).toContainText('ChatGPT')
}

/** The mode is a persisted user preference; put it back so later specs start in Standard. */
async function restoreStandardMode(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Nexus routing mode' }).click()
  await page.getByTestId('nexus-mode-standard').click()
  await expect(page.getByRole('button', { name: 'Nexus routing mode' })).toContainText('Standard')
}

async function assistantProviders(
  database: ReturnType<typeof createDatabase>,
  conversationId: string,
): Promise<string[]> {
  const rows = await database<{ provider: string }[]>`
    SELECT m.provider FROM nexus_messages n JOIN ai_models m ON m.id = n.model_id
    WHERE n.conversation_id = ${conversationId} AND n.role = 'assistant'
  `
  return rows.map(row => row.provider)
}

test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Nexus ChatGPT provider errors (#1849)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run',
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  test('an unconfigured provider shows an actionable message, not the generic failure', async ({
    page,
  }, testInfo) => {
    await page.route('**/api/nexus/chat', async route => {
      if (route.request().method() !== 'POST') {
        await route.fallback()
        return
      }
      await route.fulfill({
        status: 503,
        headers: { 'content-type': 'application/json', 'x-request-id': 'e2e-1849' },
        body: JSON.stringify({
          error: PROVIDER_NOT_CONFIGURED_MESSAGE,
          code: PROVIDER_NOT_CONFIGURED_CODE,
          requestId: 'e2e-1849',
        }),
      })
    })

    await gotoNexus(page)
    await sendMessage(page, 'Hello from the #1849 error-path spec')

    const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Model unavailable' })
    await expect(toast).toBeVisible({ timeout: 30_000 })
    await expect(toast).toContainText('Switch to Standard mode or another model family')
    await expect(page.getByText('Failed to process chat request')).toHaveCount(0)

    await page.screenshot({
      path: testInfo.outputPath('nexus-provider-not-configured.png'),
      fullPage: true,
    })
  })

  test('Advanced ChatGPT answers on the Bedrock-hosted GPT model', async ({ page }, testInfo) => {
    test.skip(process.env.E2E_RUN_EXTERNAL !== '1', 'Requires live Bedrock credentials')
    test.setTimeout(300_000)

    const database = createDatabase()
    let advancedSelected = false
    try {
      const [model] = await database<{ id: number }[]>`
        INSERT INTO ai_models (name, model_id, provider, capabilities, active, nexus_enabled, architect_enabled)
        VALUES (
          ${GPT_MODEL_NAME}, ${GPT_MODEL_ID}, 'amazon-bedrock',
          '["chat", "function_calling", "image_analysis", "streaming", "reasoning"]',
          true, true, true
        )
        ON CONFLICT (model_id) DO UPDATE
          SET active = true, nexus_enabled = true, provider = 'amazon-bedrock'
        RETURNING id
      `

      await gotoNexus(page)
      await chooseAdvancedChatGPT(page)
      advancedSelected = true
      await sendMessage(page, 'Reply with exactly the single word HERON and nothing else.')
      await waitForStreamingComplete(page, 180_000)
      await expect(page.locator('[data-role="assistant"]').last()).toContainText('HERON', {
        timeout: 60_000,
      })

      const conversationId = getConversationIdFromUrl(page)
      expect(conversationId).toBeTruthy()
      await expect
        .poll(() => assistantProviders(database, conversationId!), {
          timeout: 30_000,
          message: 'the ChatGPT reply should be served by a Bedrock row',
        })
        .toEqual(['amazon-bedrock'])
      expect(model.id).toBeGreaterThan(0)

      await page.screenshot({
        path: testInfo.outputPath('nexus-chatgpt-bedrock-success.png'),
        fullPage: true,
      })
    } finally {
      if (advancedSelected) await restoreStandardMode(page)
      await database.end()
    }
  })
})
