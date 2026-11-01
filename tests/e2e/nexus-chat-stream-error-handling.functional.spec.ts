import { test, expect, type Page } from './fixtures'
import { authenticateContext } from './helpers/session-auth'
import { gotoNexus, sendMessage } from './nexus/utils'
import { STREAM_INTERRUPTED_MESSAGE } from '@/lib/streaming/client-stream-error'

/**
 * FS#169025 / #1966 — "Error in input stream" on the first prompt of a chat.
 *
 * That text is Firefox's own message for a response body cut off mid-read: the
 * server had answered 200 and started streaming, then the connection was severed
 * (in the reported case the turn sat silent until the 300s limit). The browser's
 * body reader rejected, and the thread rendered that raw string verbatim.
 *
 * `page.route` cannot fail a body partway through, so the failure is injected in
 * the page instead: `fetch` for the chat route returns a 200 SSE response whose
 * body enqueues the opening chunks and then errors with Firefox's exact text —
 * the same rejection the real reader produces.
 */

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-vercel-ai-ui-message-stream': 'v1',
}

async function failChatBodyMidStream(page: Page, rawBrowserError: string): Promise<void> {
  await page.addInitScript(
    ({ headers, message }) => {
      const realFetch = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
        if (method !== 'POST' || !new URL(url, location.href).pathname.endsWith('/api/nexus/chat')) {
          return realFetch(input, init)
        }
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of [{ type: 'start' }, { type: 'start-step' }]) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            }
            setTimeout(() => controller.error(new TypeError(message)), 300)
          },
        })
        return new Response(body, { status: 200, headers })
      }
    },
    { headers: SSE_HEADERS, message: rawBrowserError },
  )
}

test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Nexus chat stream error handling (#1966)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run',
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  test('a body cut off mid-stream shows the sanitized message and a retry, not the raw browser error', async ({
    page,
  }, testInfo) => {
    await failChatBodyMidStream(page, 'Error in input stream')

    await gotoNexus(page)
    await sendMessage(page, 'Solve the following logic puzzle step by step.')

    const error = page.getByTestId('assistant-message-error').last()
    await expect(error).toBeVisible({ timeout: 30_000 })
    await expect(error).toHaveText(STREAM_INTERRUPTED_MESSAGE)
    await expect(page.getByText('Error in input stream')).toHaveCount(0)
    await expect(page.locator('[aria-label="Stop generating"]')).toBeHidden({ timeout: 30_000 })

    // The retry path: the failed turn keeps its regenerate action.
    const assistant = page.locator('[data-role="assistant"]').last()
    await assistant.hover()
    await expect(assistant.getByRole('button', { name: /refresh|regenerate|retry/i })).toBeVisible()

    await page.screenshot({
      path: testInfo.outputPath('nexus-1966-mid-stream-error.png'),
      fullPage: true,
    })
  })
})
