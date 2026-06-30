import { test, expect } from '../fixtures'
import { gotoNexus, sendMessage, waitForStreamingComplete, getConversationIdFromUrl } from './utils'
import { authenticateContext } from '../helpers/session-auth'

// Core Nexus chat E2E tests — auth-independent (redirect/401) and auth-required groups.

// ── Auth-independent tests ────────────────────────────────────────────────────

test.describe('Nexus — Unauthenticated Access', () => {
  test('unauthenticated user is redirected from /nexus to /sign-in', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForURL(
      (url) =>
        url.pathname.includes('/sign-in') ||
        url.pathname.includes('/auth/') ||
        url.pathname.includes('/login'),
      { timeout: 10_000 }
    )
    const url = page.url()
    expect(
      url.includes('/sign-in') || url.includes('/auth/') || url.includes('/login')
    ).toBe(true)
  })

  test('unauthenticated user is redirected from /nexus?id=<id> to /sign-in', async ({ page }) => {
    await page.goto('/nexus?id=00000000-0000-0000-0000-000000000001')
    await page.waitForURL(
      (url) =>
        url.pathname.includes('/sign-in') ||
        url.pathname.includes('/auth/') ||
        url.pathname.includes('/login'),
      { timeout: 10_000 }
    )
    const url = page.url()
    expect(
      url.includes('/sign-in') || url.includes('/auth/') || url.includes('/login')
    ).toBe(true)
  })

  test('POST /api/nexus/chat returns 401 without auth', async ({ request }) => {
    const response = await request.post('/api/nexus/chat', {
      data: {
        messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
        modelId: 'gpt-4o-mini',
        provider: 'openai',
      },
    })
    expect(response.status()).toBe(401)
  })

  test('GET /api/nexus/voice/availability returns 401 without auth', async ({ request }) => {
    const response = await request.get('/api/nexus/voice/availability')
    expect(response.status()).toBe(401)
  })
})

// ── Auth-required tests ───────────────────────────────────────────────────────

test.describe('Nexus Core Chat — Authenticated', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
    await gotoNexus(page)
  })

  test('nexus shell renders with essential UI elements', async ({ page }) => {
    // Shell container is present
    await expect(page.locator('[data-testid="nexus-shell"]')).toBeVisible()

    // Page heading
    await expect(page.locator('h1')).toBeVisible()

    // Message input is present and auto-focused
    const input = page.locator('[aria-label="Message input"]')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await expect(input).toBeFocused()

    // Send button is present
    await expect(page.locator('[aria-label="Send message"]')).toBeVisible()
  })

  test('send button is disabled while input is empty', async ({ page }) => {
    const input = page.locator('[aria-label="Message input"]')
    const sendButton = page.locator('[aria-label="Send message"]')

    await input.clear()
    await expect(sendButton).toBeDisabled()

    await input.fill('hello')
    await expect(sendButton).toBeEnabled()

    await input.fill('')
    await expect(sendButton).toBeDisabled()
  })

  test('stop button appears while AI is streaming, disappears when done', async ({ page }) => {
    await sendMessage(page, 'Respond with exactly one word: "pong"')

    // Stop button should appear during streaming
    await expect(page.locator('[aria-label="Stop generating"]')).toBeVisible({ timeout: 15_000 })

    // Wait for streaming to complete
    await waitForStreamingComplete(page)

    // Stop button should be gone
    await expect(page.locator('[aria-label="Stop generating"]')).not.toBeVisible()
  })

  test('first message produces exactly one user bubble, no duplicates', async ({ page }) => {
    const testMsg = `E2E dedup test ${Date.now()}`
    await sendMessage(page, testMsg)

    const userBubbles = page.locator('[data-role="user"]')
    await expect(userBubbles.first()).toBeVisible({ timeout: 5_000 })
    await expect(userBubbles).toHaveCount(1)
    await expect(userBubbles.first()).toContainText(testMsg)
  })

  test('AI response appears exactly once and has content', async ({ page }) => {
    await sendMessage(page, 'Say "hello" in one word')

    const assistantBubbles = page.locator('[data-role="assistant"]')
    await expect(assistantBubbles.first()).toBeVisible({ timeout: 30_000 })

    await waitForStreamingComplete(page)

    await expect(assistantBubbles).toHaveCount(1)
    const text = await assistantBubbles.first().textContent()
    expect(text?.trim().length).toBeGreaterThan(0)
  })

  test('conversation URL updates after first message', async ({ page }) => {
    await sendMessage(page, 'Hello for URL test')

    // URL updates to /nexus?id=<uuid> after conversation is created
    await page.waitForURL(
      (url) => url.pathname === '/nexus' && url.searchParams.get('id') !== null,
      { timeout: 20_000 }
    )

    const conversationId = getConversationIdFromUrl(page)
    expect(conversationId).toBeTruthy()
    expect(conversationId!.length).toBeGreaterThan(0)
  })

  test('conversation context is maintained across multiple messages', async ({ page }) => {
    await sendMessage(page, 'My name is TestUser123. Just say "got it".')
    await waitForStreamingComplete(page)

    await sendMessage(page, 'What name did I just tell you?')
    await waitForStreamingComplete(page)

    const assistantBubbles = page.locator('[data-role="assistant"]')
    await expect(assistantBubbles).toHaveCount(2)

    const secondResponse = await assistantBubbles.nth(1).textContent()
    expect(secondResponse?.toLowerCase()).toContain('testuser')
  })

  test('Cmd+Enter sends a message', async ({ page }) => {
    const input = page.locator('[aria-label="Message input"]')
    await input.fill('keyboard shortcut test')

    // Use Ctrl+Enter (maps to Cmd+Enter on Mac via the component)
    await input.press('Control+Enter')

    const userBubbles = page.locator('[data-role="user"]')
    await expect(userBubbles.first()).toBeVisible({ timeout: 5_000 })
    await expect(userBubbles.first()).toContainText('keyboard shortcut test')
  })

  test('stop button cancels ongoing streaming', async ({ page }) => {
    await sendMessage(page, 'Count slowly from 1 to 1000, one number per line')

    // Wait for streaming to start
    await expect(page.locator('[aria-label="Stop generating"]')).toBeVisible({ timeout: 15_000 })

    // Click stop
    await page.locator('[aria-label="Stop generating"]').click()

    // Stop button should disappear quickly after stopping
    await expect(page.locator('[aria-label="Stop generating"]')).not.toBeVisible({ timeout: 5_000 })

    // An assistant bubble should exist with partial content
    const assistantBubbles = page.locator('[data-role="assistant"]')
    await expect(assistantBubbles.first()).toBeVisible()
  })

  test('input is cleared after sending a message', async ({ page }) => {
    const input = page.locator('[aria-label="Message input"]')
    await input.fill('test clear input')
    await page.locator('[aria-label="Send message"]').click()

    // Input should be cleared
    await expect(input).toHaveValue('')
  })

  test('new chat button navigates to a fresh /nexus page', async ({ page }) => {
    await sendMessage(page, 'Start conversation for new-chat test')
    await page.waitForURL(
      (url) => url.pathname === '/nexus' && url.searchParams.get('id') !== null,
      { timeout: 20_000 }
    )

    const newChatBtn = page.locator('button[title="Start new chat"]')
    await expect(newChatBtn).toBeVisible()
    await newChatBtn.click()

    // New chat clears the id param — /nexus with no id means a fresh session
    await page.waitForURL(
      (url) => url.pathname === '/nexus' && url.searchParams.get('id') === null,
      { timeout: 10_000 }
    )

    const input = page.locator('[aria-label="Message input"]')
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('')
  })
})

// ── Voice Availability API ────────────────────────────────────────────────────

test.describe('Nexus Voice Availability API — Authenticated', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  test('GET /api/nexus/voice/availability returns shape when authenticated', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const response = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/voice/availability')
      return { status: res.status, body: await res.json() }
    })

    expect(response.status).toBe(200)
    expect(response.body).toHaveProperty('available')
    expect(typeof response.body.available).toBe('boolean')

    if (!response.body.available) {
      expect(response.body).toHaveProperty('reason')
      expect(typeof response.body.reason).toBe('string')
    }
  })
})
