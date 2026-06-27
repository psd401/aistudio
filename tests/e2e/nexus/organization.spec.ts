import { test, expect } from '../fixtures'
import { gotoNexus, sendMessage, waitForStreamingComplete, getConversationIdFromUrl } from './utils'

// Nexus conversation management E2E tests — CRUD, archive/pin, sidebar, pagination.

// Authenticated describes load the seeded admin session minted by
// tests/e2e/global-setup.ts. The "Unauthenticated" describe deliberately omits it.
const AUTH_A = 'tests/e2e/.auth/user-a.json'

// ── Conversations API — Auth-independent ─────────────────────────────────────

test.describe('Nexus Conversations API — Unauthenticated', () => {
  test('GET /api/nexus/conversations returns 401', async ({ request }) => {
    const res = await request.get('/api/nexus/conversations')
    expect(res.status()).toBe(401)
  })

  test('POST /api/nexus/conversations returns 401', async ({ request }) => {
    const res = await request.post('/api/nexus/conversations', {
      data: { title: 'Test', provider: 'openai' },
    })
    expect(res.status()).toBe(401)
  })

  test('PATCH /api/nexus/conversations/<id> returns 401', async ({ request }) => {
    const res = await request.patch('/api/nexus/conversations/fake-id', {
      data: { title: 'Updated' },
    })
    expect(res.status()).toBe(401)
  })

  test('GET /api/nexus/conversations/<id>/messages returns 401', async ({ request }) => {
    const res = await request.get('/api/nexus/conversations/fake-id/messages')
    expect(res.status()).toBe(401)
  })

  test('POST /api/nexus/conversations/<id>/fork returns 401', async ({ request }) => {
    const res = await request.post('/api/nexus/conversations/fake-id/fork', {
      data: { messageId: 'msg-1' },
    })
    expect(res.status()).toBe(401)
  })
})

// ── Conversations API — Authenticated ────────────────────────────────────────

test.describe('Nexus Conversations API — Authenticated', () => {
  test.use({ storageState: AUTH_A })
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test('GET /api/nexus/conversations returns list with pagination metadata', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations?limit=5&offset=0')
      return { status: res.status, body: await res.json() }
    })

    expect(result.status).toBe(200)
    expect(result.body).toHaveProperty('conversations')
    expect(Array.isArray(result.body.conversations)).toBe(true)
    expect(result.body).toHaveProperty('pagination')
    expect(result.body.pagination).toMatchObject({
      limit: 5,
      offset: 0,
    })
    expect(typeof result.body.pagination.total).toBe('number')
    expect(typeof result.body.pagination.hasMore).toBe('boolean')
  })

  test('POST /api/nexus/conversations creates a new conversation', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'E2E Test Conversation',
          provider: 'openai',
          modelId: 'gpt-4o-mini',
        }),
      })
      return { status: res.status, body: await res.json() }
    })

    expect(result.status).toBe(200)
    expect(result.body).toHaveProperty('id')
    expect(typeof result.body.id).toBe('string')
    expect(result.body.title).toBe('E2E Test Conversation')
  })

  test('PATCH /api/nexus/conversations/<id> updates title', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    // Create a conversation first
    const createResult = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Original Title', provider: 'openai' }),
      })
      return res.json()
    })

    const conversationId = createResult.id
    expect(conversationId).toBeTruthy()

    // Update the title
    const updateResult = await page.evaluate(
      async ({ id }) => {
        const res = await fetch(`/api/nexus/conversations/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Updated Title' }),
        })
        return { status: res.status, body: await res.json() }
      },
      { id: conversationId }
    )

    expect(updateResult.status).toBe(200)
    expect(updateResult.body.title).toBe('Updated Title')
  })

  test('PATCH /api/nexus/conversations/<id> archives a conversation', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const createResult = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'To Archive', provider: 'openai' }),
      })
      return res.json()
    })

    const conversationId = createResult.id

    const archiveResult = await page.evaluate(
      async ({ id }) => {
        const res = await fetch(`/api/nexus/conversations/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isArchived: true }),
        })
        return { status: res.status, body: await res.json() }
      },
      { id: conversationId }
    )

    expect(archiveResult.status).toBe(200)
    expect(archiveResult.body.isArchived).toBe(true)
  })

  test('PATCH /api/nexus/conversations/<id> pins a conversation', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const createResult = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'To Pin', provider: 'openai' }),
      })
      return res.json()
    })

    const conversationId = createResult.id

    const pinResult = await page.evaluate(
      async ({ id }) => {
        const res = await fetch(`/api/nexus/conversations/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isPinned: true }),
        })
        return { status: res.status, body: await res.json() }
      },
      { id: conversationId }
    )

    expect(pinResult.status).toBe(200)
    expect(pinResult.body.isPinned).toBe(true)
  })

  test('GET /api/nexus/conversations/<id>/messages returns empty array for new conversation', async ({
    page,
  }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const createResult = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Message Test', provider: 'openai' }),
      })
      return res.json()
    })

    const conversationId = createResult.id

    const messagesResult = await page.evaluate(
      async ({ id }) => {
        const res = await fetch(`/api/nexus/conversations/${id}/messages`)
        return { status: res.status, body: await res.json() }
      },
      { id: conversationId }
    )

    expect(messagesResult.status).toBe(200)
    expect(Array.isArray(messagesResult.body.messages)).toBe(true)
    expect(messagesResult.body.messages.length).toBe(0)
  })

  test('archived conversations are excluded from default listing', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    // Create and immediately archive a conversation
    const createResult = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `Archived-${Date.now()}`, provider: 'openai' }),
      })
      return res.json()
    })

    const id = createResult.id

    await page.evaluate(
      async ({ id }) => {
        await fetch(`/api/nexus/conversations/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isArchived: true }),
        })
      },
      { id }
    )

    // Default listing should not include archived conversations
    const listResult = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations?limit=100&offset=0')
      return res.json()
    })

    const archivedInList = listResult.conversations.find(
      (c: { id: string; isArchived: boolean }) => c.id === id
    )
    expect(archivedInList).toBeUndefined()

    // But includeArchived=true should include it
    const archivedListResult = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations?limit=100&offset=0&includeArchived=true')
      return res.json()
    })

    const archivedInList2 = archivedListResult.conversations.find(
      (c: { id: string; isArchived: boolean }) => c.id === id
    )
    expect(archivedInList2).toBeDefined()
    expect(archivedInList2.isArchived).toBe(true)
  })

  test('pagination hasMore reflects when more conversations exist', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations?limit=1&offset=0')
      return res.json()
    })

    // If there is more than 1 conversation total, hasMore should be true
    if (result.pagination.total > 1) {
      expect(result.pagination.hasMore).toBe(true)
    } else {
      expect(result.pagination.hasMore).toBe(false)
    }
  })
})

// ── Sidebar UI — Authenticated ────────────────────────────────────────────────

test.describe('Nexus Sidebar — Authenticated', () => {
  test.use({ storageState: AUTH_A })
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test('conversation created via chat appears in sidebar', async ({ page }) => {
    // Sending a chat message requires a live AI model to respond (the conversation
    // is created by the streamed turn). Gate behind E2E_RUN_EXTERNAL like the other
    // live-provider specs so the keyless default run doesn't fail here.
    test.skip(
      process.env.E2E_RUN_EXTERNAL !== '1',
      'Creating a conversation via chat needs a live model — set E2E_RUN_EXTERNAL=1'
    )
    await gotoNexus(page)

    const uniqueMsg = `Sidebar test ${Date.now()}`
    await sendMessage(page, uniqueMsg)

    // Wait for conversation URL to establish
    await page.waitForURL(
      (url) => url.pathname === '/nexus' && url.searchParams.get('id') !== null,
      { timeout: 20_000 }
    )

    // Sidebar should show a thread entry — look for the archive button rendered per thread
    const threadItems = page.locator('[aria-label="Archive thread"], [aria-label*="Archive"]')
    await expect(threadItems.first()).toBeVisible({ timeout: 10_000 })
  })

  test('new conversation URL resolves on /nexus', async ({ page }) => {
    await gotoNexus(page)

    await sendMessage(page, 'Create conversation for direct URL navigation test')
    await page.waitForURL(
      (url) => url.pathname === '/nexus' && url.searchParams.get('id') !== null,
      { timeout: 20_000 }
    )

    const conversationId = getConversationIdFromUrl(page)
    expect(conversationId).toBeTruthy()

    // Navigate away and back using the query-param form /nexus?id=<uuid>
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    await page.goto(`/nexus?id=${conversationId}`)
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })
    expect(page.url()).toContain(conversationId!)
  })

  test('sending multiple messages maintains correct message count', async ({ page }) => {
    await gotoNexus(page)

    await sendMessage(page, 'First message')
    await page.locator('[data-role="assistant"]').first().waitFor({ timeout: 30_000 })
    await waitForStreamingComplete(page)

    await sendMessage(page, 'Second message')
    await waitForStreamingComplete(page)

    const userBubbles = page.locator('[data-role="user"]')
    const assistantBubbles = page.locator('[data-role="assistant"]')

    await expect(userBubbles).toHaveCount(2)
    await expect(assistantBubbles).toHaveCount(2)
  })
})

// ── Input Validation ──────────────────────────────────────────────────────────

test.describe('Nexus Conversations API — Input Validation', () => {
  test.use({ storageState: AUTH_A })
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test('invalid provider filter in GET is ignored (no 500)', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations?provider=evil%3Binjection')
      return { status: res.status, body: await res.json() }
    })

    // Invalid provider is silently ignored per whitelist logic — should return normal response
    expect(result.status).toBe(200)
    // Verify response body is unaffected by the injected value (not corrupted or empty)
    expect(Array.isArray(result.body.conversations)).toBe(true)
    expect(result.body).toHaveProperty('pagination')
    expect(typeof result.body.pagination.total).toBe('number')
  })

  test('extremely large limit is clamped to 500', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations?limit=99999&offset=0')
      return { status: res.status, body: await res.json() }
    })

    expect(result.status).toBe(200)
    // Limit is clamped to 500 max (per implementation)
    expect(result.body.pagination.limit).toBeLessThanOrEqual(500)
  })

  test('negative offset is normalized to 0', async ({ page }) => {
    await page.goto('/nexus')
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/nexus/conversations?offset=-100')
      return { status: res.status, body: await res.json() }
    })

    expect(result.status).toBe(200)
    expect(result.body.pagination.offset).toBe(0)
  })
})
