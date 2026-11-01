import { test, expect, type Page } from './fixtures'
import { authenticateContext } from './helpers/session-auth'
import { gotoNexus, sendMessage } from './nexus/utils'
import { emptyTurnNotice } from '@/lib/streaming/empty-turn-notice'

/**
 * #1899 — "Nexus: never end a turn with nothing for the user to read".
 *
 * In a read of 375 staff members' Nexus use (Aug–Oct 2026), ~45 people hit a
 * turn with no reply and resent the same message two to six times. Two of the
 * shapes behind it render as a completely blank assistant bubble:
 *
 *  1. a reasoning-only turn — the Thread's `DEFAULT_ASSISTANT_MESSAGE_CONTENT_COMPONENTS`
 *     registers NO Reasoning renderer, so `reasoning-*` parts draw nothing, and
 *  2. a turn that spends its whole step budget on tool calls and never answers.
 *
 * The server now appends a terminal `error` chunk naming what happened
 * (`buildAbortAwareResponse` → `classifyEmptyTurn`). These specs pin the half
 * only a browser can prove: that the notice actually renders through the real
 * assistant-ui / AI SDK client stack, beside (not instead of) whatever the turn
 * did produce, and that the spinner clears.
 *
 * The provider is mocked at the network boundary (`page.route`) rather than
 * driven live — a model that thinks and then returns no text is not something a
 * real provider can be asked for on demand, and the point under test is the
 * wire format, not the model.
 *
 * SCOPE NOTE: because the mocked body bypasses the server, nothing is written to
 * the database here, so this spec cannot assert the notice survives a reload.
 * That half — a notice row persisted for an answer-less turn instead of the
 * turn being dropped — is pinned by
 * `app/api/nexus/chat/__tests__/assistant-turn-persistence.test.ts` and
 * `app/api/nexus/chat/__tests__/incomplete-turn.test.ts`.
 */

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
}

/** One SSE frame per chunk, in the UI-message-stream v1 wire format. */
function sse(chunks: unknown[]): string {
  return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
}

/** Serve `body` for the next chat turn instead of calling a real provider. */
async function mockChatStream(page: Page, body: string): Promise<void> {
  await page.route('**/api/nexus/chat', async route => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }
    await route.fulfill({ status: 200, headers: SSE_HEADERS, body })
  })
}

test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Nexus empty-turn notice (#1899)', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  test('a reasoning-only turn says so instead of rendering a blank bubble', async ({ page }) => {
    // Exactly what the server now produces: the reasoning parts the model did
    // emit, then the terminal notice. The thread draws nothing for the former.
    const body = sse([
      { type: 'start' },
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'Considering the attendance policy…' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'finish-step' },
      { type: 'error', errorText: emptyTurnNotice('reasoning_only') },
    ])
    await mockChatStream(page, body)

    await gotoNexus(page)
    await sendMessage(page, 'Summarize the attendance policy.')

    await expect(
      page.getByText(/finished thinking but never wrote an answer/i).first()
    ).toBeVisible({ timeout: 30_000 })
    // The turn must not look like it is still running.
    await expect(page.locator('[aria-label="Stop generating"]')).toBeHidden({ timeout: 30_000 })

    await page.screenshot({
      path: '.verification/nexus-1899-reasoning-only-notice.png',
      fullPage: false,
    })
  })

  test('a turn that spends every tool step without answering says so', async ({ page }) => {
    // `resolveMaxSteps` gives an ordinary turn three steps, so a `web_fetch`
    // chain can end with tool cards and no answer (#1899 case 2).
    const body = sse([
      { type: 'start' },
      { type: 'start-step' },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'web_fetch',
        input: { url: 'https://example.test/policy' },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'c1',
        output: { title: 'Policy index' },
      },
      { type: 'finish-step' },
      { type: 'error', errorText: emptyTurnNotice('step_budget_exhausted') },
    ])
    await mockChatStream(page, body)

    await gotoNexus(page)
    await sendMessage(page, 'Read https://example.test/policy and summarize it.')

    await expect(page.getByText(/used up all of its tool steps/i).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.locator('[aria-label="Stop generating"]')).toBeHidden({ timeout: 30_000 })

    await page.screenshot({
      path: '.verification/nexus-1899-step-budget-notice.png',
      fullPage: false,
    })
  })
})
