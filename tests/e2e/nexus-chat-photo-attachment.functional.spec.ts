import { test, expect, type Page } from './fixtures'
import { authenticateContext } from './helpers/session-auth'
import { gotoNexus, sendMessage, waitForStreamingComplete } from './nexus/utils'
import { MAX_IMAGE_EDGE_PX } from '@/lib/attachments/image-downscale'

/**
 * FS#167985 / #1850 — "Failed to respond" after attaching photos.
 *
 * The standard chat route hands the model each image's inline data URL, and the
 * AI SDK resends the whole history every turn. Full-size phone photos pushed the
 * request past the 10MB body Next.js buffers for proxied routes; the body was
 * truncated, JSON.parse threw, and every later turn failed with a 500.
 *
 * Flow `nexus-chat-photo-attachment`: a 12MP, several-MB JPEG is attached via the
 * composer's file chooser in a conversation a few messages in, then a second and
 * a third photo later. The client contract checked on every request:
 *  - the body stays under 10MB even as photos accumulate in the history (before
 *    the fix this request was ~14MB), and
 *  - each inline image was shrunk to a <= 2048px longest edge.
 * Replies are served at the network boundary so the check is about the wire,
 * not a model. The live variant (E2E_RUN_EXTERNAL=1) sends the same photo to the
 * real route and model.
 */

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-vercel-ai-ui-message-stream': 'v1',
}
const TEN_MB = 10 * 1024 * 1024

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

/** A 4032x3024 noisy JPEG, phone-camera sized, generated in the page. */
async function makePhonePhoto(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 4032
    canvas.height = 3024
    const context = canvas.getContext('2d')!
    const tile = context.createImageData(256, 256)
    for (let i = 0; i < tile.data.length; i += 4) {
      tile.data[i] = Math.random() * 255
      tile.data[i + 1] = Math.random() * 255
      tile.data[i + 2] = Math.random() * 255
      tile.data[i + 3] = 255
    }
    for (let x = 0; x < canvas.width; x += 256) {
      for (let y = 0; y < canvas.height; y += 256) context.putImageData(tile, x, y)
    }
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/jpeg', 0.92))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x80_00) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x80_00))
    }
    return btoa(binary)
  })
  return Buffer.from(base64, 'base64')
}

async function attachPhoto(page: Page, photo: Buffer, name: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /add attachment/i }).click()
  await (await chooser).setFiles({ name, mimeType: 'image/jpeg', buffer: photo })
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 })
}

/** Image data URLs in a chat request body, and their decoded dimensions. */
async function inlineImageEdges(page: Page, body: string): Promise<number[]> {
  const urls = [...body.matchAll(/"(data:image\/[a-z]+;base64,[^"]+)"/g)].map(match => match[1])
  return page.evaluate(async dataUrls => {
    const edges: number[] = []
    for (const url of dataUrls) {
      const image = new Image()
      image.src = url
      await image.decode()
      edges.push(Math.max(image.naturalWidth, image.naturalHeight))
    }
    return edges
  }, urls)
}

test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Nexus chat photo attachments (#1850)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run',
  )
  test.describe.configure({ timeout: 240_000 })

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  test('photos added across turns keep every request small and downscaled', async ({ page }, testInfo) => {
    const bodies: string[] = []
    await page.route('**/api/nexus/chat', async route => {
      if (route.request().method() !== 'POST') return route.fallback()
      bodies.push(route.request().postData() ?? '')
      await route.fulfill({ status: 200, headers: SSE_HEADERS, body: sseReply(`Reply ${bodies.length}`) })
    })

    await gotoNexus(page)
    const photo = await makePhonePhoto(page)
    expect(photo.length).toBeGreaterThan(4 * 1024 * 1024)
    expect(photo.length).toBeLessThan(20 * 1024 * 1024)

    // A few messages in, as in the report.
    await sendMessage(page, 'Hello, I have some photos to share.')
    await expect(page.getByText('Reply 1')).toBeVisible({ timeout: 30_000 })

    for (const [turn, name] of [[2, 'photo-1.jpg'], [3, 'photo-2.jpg'], [4, 'photo-3.jpg']] as const) {
      await attachPhoto(page, photo, name)
      await sendMessage(page, `What do you see in ${name}?`)
      await expect(page.getByText(`Reply ${turn}`)).toBeVisible({ timeout: 60_000 })
      await waitForStreamingComplete(page, 60_000)
    }

    expect(bodies).toHaveLength(4)
    for (const body of bodies) expect(body.length).toBeLessThan(TEN_MB)
    // The last request resends all three photos in its history.
    const edges = await inlineImageEdges(page, bodies[3])
    expect(edges).toHaveLength(3)
    for (const edge of edges) expect(edge).toBeLessThanOrEqual(MAX_IMAGE_EDGE_PX)

    await page.screenshot({ path: testInfo.outputPath('nexus-1850-photos.png'), fullPage: true })
  })

  test('live: a phone photo gets a real reply', async ({ page }, testInfo) => {
    test.skip(process.env.E2E_RUN_EXTERNAL !== '1', 'Requires live model credentials')
    const statuses: number[] = []
    page.on('response', response => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/nexus/chat') {
        statuses.push(response.status())
      }
    })

    await gotoNexus(page)
    const photo = await makePhonePhoto(page)
    await attachPhoto(page, photo, 'phone-photo.jpg')
    await sendMessage(page, 'In one short sentence, what is the main thing you notice here?')
    await waitForStreamingComplete(page, 180_000)

    expect(statuses).toEqual([200])
    const reply = page.locator('[data-role="assistant"]').last()
    await expect(reply).not.toBeEmpty()
    await expect(page.getByTestId('assistant-message-error')).toHaveCount(0)

    await page.screenshot({ path: testInfo.outputPath('nexus-1850-live-photo.png'), fullPage: true })
  })
})
