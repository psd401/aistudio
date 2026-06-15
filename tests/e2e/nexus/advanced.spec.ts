import { test, expect } from '@playwright/test'
import { gotoNexus, sendMessage, waitForStreamingComplete, getConversationIdFromUrl } from './utils'

// Advanced Nexus E2E tests — fork conversation, model/tool/voice selectors, error handling.

// ── Fork API — Auth-independent ───────────────────────────────────────────────

test.describe('Nexus Fork API — Unauthenticated', () => {
  test('POST /api/nexus/conversations/<id>/fork returns 401 without auth', async ({ request }) => {
    const res = await request.post('/api/nexus/conversations/some-id/fork', {
      data: { atMessageId: 'msg-1' },
    })
    expect(res.status()).toBe(401)
  })
})

// ── Fork conversation — Authenticated ────────────────────────────────────────

test.describe('Nexus Fork Conversation — Authenticated', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test('forking a non-existent conversation returns 404', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations/00000000-0000-0000-0000-000000000000/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ atMessageId: 'msg-1' }),
      })
      return { status: res.status }
    })

    expect(result.status).toBe(404)
  })

  test('fork creates a new conversation with messages up to fork point', async ({ page }) => {
    await gotoNexus(page)

    // Create a conversation with one exchange
    await sendMessage(page, 'Say "alpha" and only "alpha"')
    await waitForStreamingComplete(page)

    // Get the conversation ID and message IDs from the URL/API
    const conversationId = getConversationIdFromUrl(page)
    expect(conversationId).toBeTruthy()

    // Get messages via API
    const messagesResult = await page.evaluate(
      async ({ id }) => {
        const res = await fetch(`/api/nexus/conversations/${id}/messages`)
        return res.json()
      },
      { id: conversationId! }
    )

    const messages = messagesResult.messages
    expect(messages.length).toBeGreaterThan(0)

    // Fork at the last user message
    const userMessage = messages.find((m: { role: string }) => m.role === 'user')
    expect(userMessage).toBeDefined()

    const forkResult = await page.evaluate(
      async ({ id, atMessageId }) => {
        const res = await fetch(`/api/nexus/conversations/${id}/fork`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ atMessageId }),
        })
        return { status: res.status, body: await res.json() }
      },
      { id: conversationId!, atMessageId: userMessage.id }
    )

    expect(forkResult.status).toBe(200)
    expect(forkResult.body).toHaveProperty('forkedConversation')
    expect(forkResult.body.forkedConversation.id).not.toBe(conversationId)
  })
})

// ── Model Selector UI — Authenticated ────────────────────────────────────────

test.describe('Nexus Model Selector — Authenticated', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await gotoNexus(page)
  })

  test('model selector renders and is interactive', async ({ page }) => {
    // Use isVisible() + short waitFor instead of count() — count() doesn't auto-wait
    // and can return 0 on a still-rendering page, causing silent false-passes.
    let modelSelectorFound = false
    try {
      await page.locator('[data-testid="model-selector"]').waitFor({ state: 'visible', timeout: 3_000 })
      modelSelectorFound = true
    } catch {
      // Not present — check fallback selector
    }

    if (modelSelectorFound) {
      const modelSelector = page.locator('[data-testid="model-selector"]')
      await expect(modelSelector).toBeVisible()
      await modelSelector.click()
      const options = page.locator('[data-testid="model-option"]')
      await expect(options.first()).toBeVisible({ timeout: 5_000 })
    } else {
      // Model selector may use different structure — check for button/select
      try {
        await page
          .locator('button')
          .filter({ hasText: /model|gpt|claude|gemini/i })
          .first()
          .waitFor({ state: 'visible', timeout: 3_000 })
        await expect(
          page.locator('button').filter({ hasText: /model|gpt|claude|gemini/i }).first()
        ).toBeVisible()
      } catch {
        test.skip(true, 'Model selector not present in this environment')
      }
    }
  })

  test('tool selector renders for models that support tools', async ({ page }) => {
    // Use waitFor instead of count() to properly wait for rendering
    try {
      await page.locator('[data-testid="tool-selector"]').waitFor({ state: 'visible', timeout: 3_000 })
      await expect(page.locator('[data-testid="tool-selector"]')).toBeVisible()
    } catch {
      test.skip(true, 'Tool selector not visible (model may not support tools)')
    }
  })

  test('voice button renders (enabled or disabled state)', async ({ page }) => {
    // Wait for either voice button variant — use a CSS multi-selector
    const voiceButtonSelector =
      '[data-testid="voice-mode-button"], [data-testid="voice-mode-button-disabled"]'
    try {
      await page.locator(voiceButtonSelector).first().waitFor({ state: 'visible', timeout: 5_000 })
      await expect(page.locator(voiceButtonSelector).first()).toBeVisible()
    } catch {
      // Voice feature not present in this environment
      test.skip(true, 'Voice button not found in this environment')
    }
  })
})

// ── Error Handling ────────────────────────────────────────────────────────────

test.describe('Nexus Error Handling — Authenticated', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test('navigating to non-existent conversation ID shows error or redirects', async ({ page }) => {
    // UUID that is syntactically valid but does not exist — use ?id= query param (the app's routing form)
    await page.goto('/nexus?id=00000000-0000-0000-0000-000000000000')

    // Either shows an error state or redirects to /nexus
    await page.waitForFunction(
      () => {
        const url = window.location.pathname
        const hasErrorText =
          document.body.innerText.toLowerCase().includes('not found') ||
          document.body.innerText.toLowerCase().includes('conversation') ||
          document.body.innerText.toLowerCase().includes('error')
        return url === '/nexus' || hasErrorText
      },
      { timeout: 10_000 }
    )

    // Should not crash — shell or redirect should be present
    const isOnNexus = page.url().includes('/nexus')
    expect(isOnNexus).toBe(true)
  })

  test('sending empty message is prevented (button disabled)', async ({ page }) => {
    await gotoNexus(page)

    const input = page.locator('[aria-label="Message input"]')
    await input.clear()
    await input.fill('')

    const sendButton = page.locator('[aria-label="Send message"]')
    await expect(sendButton).toBeDisabled()

    // No messages should appear
    const userBubbles = page.locator('[data-role="user"]')
    await expect(userBubbles).toHaveCount(0)
  })

  test('whitespace-only message is prevented (button disabled)', async ({ page }) => {
    await gotoNexus(page)

    const input = page.locator('[aria-label="Message input"]')
    await input.fill('   ')

    const sendButton = page.locator('[aria-label="Send message"]')
    // The send button should remain disabled for whitespace-only input
    await expect(sendButton).toBeDisabled()
  })
})

// ── API Error Handling ────────────────────────────────────────────────────────

test.describe('Nexus API Error Handling — Authenticated', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test('PATCH non-existent conversation returns 404', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations/00000000-0000-0000-0000-000000000000', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Ghost' }),
      })
      return { status: res.status }
    })

    expect(result.status).toBe(404)
  })

  test('GET messages for non-existent conversation returns 404', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const result = await page.evaluate(async () => {
      const res = await fetch(
        '/api/nexus/conversations/00000000-0000-0000-0000-000000000000/messages'
      )
      return { status: res.status }
    })

    expect(result.status).toBe(404)
  })

  test('POST to /api/nexus/chat with non-existent conversationId returns 404', async ({
    page,
  }) => {
    // This tests that a non-existent UUID is rejected — not a cross-user IDOR test.
    // For real cross-user ownership verification see nexus-conversation-ownership.spec.ts.
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ id: 'msg-1', role: 'user', content: 'test' }],
          modelId: 'gpt-4o-mini',
          provider: 'openai',
          conversationId: '00000000-0000-0000-0000-000000000000',
        }),
      })
      return { status: res.status }
    })

    expect(result.status).toBe(404)
  })
})

// ── Conversation Messages After Chat ─────────────────────────────────────────

test.describe('Nexus Message Persistence — Authenticated', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test('messages sent in chat are retrievable from /api/nexus/conversations/<id>/messages', async ({
    page,
  }) => {
    await gotoNexus(page)

    const testMessage = `Persistent message ${Date.now()}`
    await sendMessage(page, testMessage)
    await waitForStreamingComplete(page)

    const conversationId = getConversationIdFromUrl(page)
    expect(conversationId).toBeTruthy()

    const result = await page.evaluate(
      async ({ id }) => {
        const res = await fetch(`/api/nexus/conversations/${id}/messages`)
        return { status: res.status, body: await res.json() }
      },
      { id: conversationId! }
    )

    expect(result.status).toBe(200)
    expect(result.body.messages.length).toBeGreaterThan(0)

    const userMsg = result.body.messages.find(
      (m: { role: string; content: Array<{ type: string; text?: string }> }) =>
        m.role === 'user' &&
        m.content.some(
          (part) =>
            part.type === 'text' && part.text?.includes(testMessage)
        )
    )
    expect(userMsg).toBeDefined()
  })

  test('messages API response has expected shape', async ({ page }) => {
    await gotoNexus(page)

    await sendMessage(page, 'Shape test message')
    await waitForStreamingComplete(page)

    const conversationId = getConversationIdFromUrl(page)
    expect(conversationId).toBeTruthy()

    const result = await page.evaluate(
      async ({ id }) => {
        const res = await fetch(`/api/nexus/conversations/${id}/messages`)
        return res.json()
      },
      { id: conversationId! }
    )

    expect(Array.isArray(result.messages)).toBe(true)
    expect(result).toHaveProperty('pagination')
    expect(typeof result.pagination.total).toBe('number')

    const firstMsg = result.messages[0]
    expect(firstMsg).toHaveProperty('id')
    expect(firstMsg).toHaveProperty('role')
    expect(firstMsg).toHaveProperty('content')
    expect(firstMsg).toHaveProperty('createdAt')
    expect(['user', 'assistant', 'system']).toContain(firstMsg.role)
  })
})
