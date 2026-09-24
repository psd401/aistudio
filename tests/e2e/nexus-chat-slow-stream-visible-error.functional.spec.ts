import { test, expect, type Page } from './fixtures'
import { authenticateContext } from './helpers/session-auth'
import { gotoNexus, sendMessage } from './nexus/utils'

/**
 * FS#164150 / #1698 — "chat appears to have been ingested, but then abandoned".
 *
 * A reasoning-tier turn emits `start` immediately and can then stay silent for
 * the whole think/tool phase. The ALB idles the socket out at 300s, so the
 * terminal `error` chunk the server appends on abort never reached the browser:
 * the turn just stopped, with no answer and no error.
 *
 * The server-side fix injects SSE comment frames (`: keep-alive`) into the
 * response body during a silent stretch (`lib/streaming/sse-keep-alive.ts`).
 * These specs pin the two browser-visible halves of that contract, which the
 * node-side unit tests cannot reach:
 *
 *  1. comment frames pass through the real assistant-ui / AI SDK client stack
 *     without disturbing the rendered answer, and
 *  2. a turn that goes quiet and is then cut short renders a visible error
 *     rather than an indefinite spinner.
 *
 * The provider is mocked at the network boundary (`page.route`) rather than
 * driven live: a real several-minute silent gap is not runnable in a test, and
 * the point under test is the wire format, not the model.
 */

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
}

const ANSWER = 'The address is 14015 62nd Ave NW, Gig Harbor.'

/** One SSE frame per chunk, in the UI-message-stream v1 wire format. */
function sse(chunks: unknown[]): string {
  return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
}

/** Splice keep-alive comment frames into a body, standing in for a silent gap. */
function withKeepAlives(body: string, marker: string, count: number): string {
  const filler = ': keep-alive\n\n'.repeat(count)
  const at = body.indexOf(marker)
  expect(at).toBeGreaterThan(-1)
  return body.slice(0, at) + filler + body.slice(at)
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

test.describe('Nexus slow/silent stream (#1698)', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  test('keep-alive frames during a silent stretch leave the answer intact', async ({ page }) => {
    const body = withKeepAlives(
      sse([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: ANSWER },
        { type: 'text-end', id: 't1' },
        { type: 'finish-step' },
        { type: 'finish' },
      ]),
      'data: {"type":"text-start"',
      12
    )
    await mockChatStream(page, body)

    await gotoNexus(page)
    await sendMessage(page, 'Find the address of the district office.')

    // The comment frames must be discarded by the SSE parser before they can
    // reach processUIMessageStream — the answer renders exactly as it would
    // without them, and no stray ": keep-alive" text leaks into the thread.
    const assistant = page.locator('[data-role="assistant"]').first()
    await expect(assistant).toContainText(ANSWER, { timeout: 30_000 })
    await expect(assistant).not.toContainText('keep-alive')
    await expect(page.locator('[aria-label="Stop generating"]')).toBeHidden({ timeout: 30_000 })

    await page.screenshot({
      path: '.verification/nexus-1698-keepalive-answer-intact.png',
      fullPage: false,
    })
  })

  test('a turn cut short after the silence shows a visible error, not a stuck spinner', async ({
    page,
  }) => {
    // Exactly what the server now produces when the app-level deadline fires
    // after a long quiet stretch: keep-alives held the socket open, so the
    // terminal error chunk actually arrives.
    const body = withKeepAlives(
      sse([
        { type: 'start' },
        { type: 'start-step' },
        {
          type: 'error',
          errorText:
            'The response was cut off before it finished — the model ran out of time. Try asking again, or break the request into smaller parts.',
        },
      ]),
      'data: {"type":"error"',
      12
    )
    await mockChatStream(page, body)

    await gotoNexus(page)
    await sendMessage(page, 'Find the address of the district office.')

    await expect(page.getByText(/cut off before it finished/i).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.locator('[aria-label="Stop generating"]')).toBeHidden({ timeout: 30_000 })

    await page.screenshot({
      path: '.verification/nexus-1698-visible-cutoff-error.png',
      fullPage: false,
    })
  })
})
