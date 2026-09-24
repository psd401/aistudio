import { test, expect, type Page } from './fixtures'
import { authenticateContext } from './helpers/session-auth'
import { SSE_KEEP_ALIVE_FRAME } from '@/lib/streaming/sse-keep-alive'

/**
 * #1698 on the Assistant Architect path.
 *
 * A prompt chain runs every prompt but the last before the streaming Response
 * exists, so the route now commits to the SSE response after a grace period,
 * fills the wait with keep-alive comments, and — if the chain then fails —
 * reports the failure as an AI SDK `error` chunk (`{ type, errorText }`).
 *
 * Before this change the Assistant Architect client could not show that
 * chunk: its `isErrorEvent` guard only matches `{ error }`, and the throw for
 * the one shape it did match was swallowed as a parse failure. These specs pin
 * the browser-visible contract:
 *
 *  1. keep-alive frames ahead of the answer leave the output intact, and
 *  2. an `errorText` chunk after a quiet stretch renders a visible error.
 *
 * Client-contract specs only: the execute route is mocked at the network
 * boundary, so the server side is covered by
 * `lib/streaming/__tests__/deferred-ui-message-stream.test.ts`.
 *
 * Fixture: tests/e2e/fixtures/assistant-architect-seed.sql seeds 9000, an
 * admin-owned approved architect whose only input field is optional.
 */

const ARCHITECT_ID = 9000
const ANSWER = 'Lesson plan: fractions on a number line.'

function sse(chunks: unknown[]): string {
  return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
}

async function mockExecute(page: Page, body: string): Promise<void> {
  await page.route('**/api/assistant-architect/execute', async route => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
        'X-Execution-Id': '99101',
        'X-Prompt-Count': '1',
      },
      body,
    })
  })
}

async function generate(page: Page): Promise<void> {
  await page.goto(`/tools/assistant-architect/${ARCHITECT_ID}`)
  const button = page.getByRole('button', { name: 'Generate' })
  await expect(button).toBeEnabled({ timeout: 30_000 })
  await button.click()
}

test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Assistant Architect slow chain (#1698)', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  test('keep-alive frames ahead of the answer leave the output intact', async ({ page }) => {
    await mockExecute(
      page,
      SSE_KEEP_ALIVE_FRAME.repeat(8) +
        sse([
          { type: 'start' },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: ANSWER },
          { type: 'text-end', id: 't1' },
          { type: 'finish' },
        ])
    )

    await generate(page)

    await expect(page.getByText(ANSWER).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('keep-alive')).toHaveCount(0)

    await page.screenshot({
      path: '.verification/aa-1698-keepalive-answer-intact.png',
      fullPage: false,
    })
  })

  test('a chain that fails after a quiet stretch shows a visible error', async ({ page }) => {
    const message = 'Failed to execute assistant architect'
    await mockExecute(
      page,
      SSE_KEEP_ALIVE_FRAME.repeat(8) + sse([{ type: 'error', errorText: message }])
    )

    await generate(page)

    await expect(page.getByText(`Error: ${message}`).first()).toBeVisible({ timeout: 30_000 })

    await page.screenshot({
      path: '.verification/aa-1698-late-error-visible.png',
      fullPage: false,
    })
  })
})
