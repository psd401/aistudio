import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from './fixtures'
import { authenticateContext } from './helpers/session-auth'
import { gotoNexus, sendMessage, waitForStreamingComplete } from './nexus/utils'

/**
 * 2026-11-15 prod report — "Getting Error Message EVERYTIME if I try to upload a
 * image": an iPhone HEIC photo attached in Nexus on Chrome/macOS.
 *
 * `VisionImageAdapter` only accepted jpeg/png/webp/gif, so the HEIC fell through
 * to assistant-ui's `SimpleImageAttachmentAdapter` and was inlined verbatim as
 * `data:image/heic`. Bedrock Claude rejected it ("Unsupported image mime type:
 * image/heic"), and because the client resends history every turn, every later
 * turn in that conversation failed with "Something went wrong while writing the
 * response, so it stopped partway."
 *
 * Flow `nexus-heic-photo-attachment`: a real HEIC (made with macOS `sips`) is
 * attached through the composer's file chooser. The composer must convert it in
 * the browser — Chrome cannot decode HEIC natively, so this exercises the lazily
 * loaded `heic-to` WASM decoder and its blob: Worker under the app's real CSP —
 * and the chat request must carry a JPEG, never `image/heic`. Replies are served
 * at the network boundary: the check is about the wire, not a model.
 */

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-vercel-ai-ui-message-stream': 'v1',
}

function sseReply(text: string): string {
  return [
    { type: 'start' },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish-step' },
    { type: 'finish' },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
}

const HEIC_FIXTURE = readFileSync(join(__dirname, 'fixtures', 'images', 'iphone-photo.heic'))

async function chooseFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /add attachment/i }).click()
  await (await chooser).setFiles(file)
}

/** Decoded size of each inline image data URL in a request body. */
async function inlineImages(page: Page, body: string): Promise<Array<{ type: string; width: number }>> {
  const urls = [...body.matchAll(/"(data:image\/[\w+.-]+;base64,[^"]+)"/g)].map(match => match[1])
  return page.evaluate(async dataUrls => {
    const out: Array<{ type: string; width: number }> = []
    for (const url of dataUrls) {
      const image = new Image()
      image.src = url
      await image.decode()
      out.push({ type: url.slice(5, url.indexOf(';')), width: image.naturalWidth })
    }
    return out
  }, urls)
}

test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Nexus HEIC photo attachments', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run',
  )
  test.describe.configure({ timeout: 180_000 })

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  test('an iPhone HEIC is converted to JPEG before it is sent', async ({ page }, testInfo) => {
    const bodies: string[] = []
    await page.route('**/api/nexus/chat', async route => {
      if (route.request().method() !== 'POST') return route.fallback()
      bodies.push(route.request().postData() ?? '')
      await route.fulfill({ status: 200, headers: SSE_HEADERS, body: sseReply(`Reply ${bodies.length}`) })
    })
    const cspViolations: string[] = []
    page.on('console', message => {
      if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text())
    })

    await gotoNexus(page)
    await chooseFile(page, { name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: HEIC_FIXTURE })

    // The chip shows the converted name; no rejection toast.
    await expect(page.getByText('IMG_0001.jpg').first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('Image could not be attached')).toHaveCount(0)

    await sendMessage(page, 'What is in this photo?')
    await expect(page.getByText('Reply 1')).toBeVisible({ timeout: 60_000 })
    await waitForStreamingComplete(page, 60_000)

    // A second turn resends the history — it must still carry no HEIC.
    await sendMessage(page, 'And what colour is it?')
    await expect(page.getByText('Reply 2')).toBeVisible({ timeout: 60_000 })

    expect(bodies).toHaveLength(2)
    for (const body of bodies) expect(body).not.toContain('image/heic')
    const images = await inlineImages(page, bodies[1])
    expect(images).toEqual([{ type: 'image/jpeg', width: 320 }])
    expect(cspViolations).toEqual([])

    await page.screenshot({ path: testInfo.outputPath('nexus-heic-converted.png'), fullPage: true })
  })

  test('an SVG is refused at attach time with an actionable message', async ({ page }, testInfo) => {
    await gotoNexus(page)
    await chooseFile(page, {
      name: 'diagram.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
    })

    await expect(page.getByText('Image could not be attached')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/Export it as PNG or JPEG/)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('nexus-svg-refused.png'), fullPage: true })
  })
})
