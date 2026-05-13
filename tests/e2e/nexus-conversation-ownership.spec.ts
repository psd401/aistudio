import { test, expect } from '@playwright/test'

/**
 * Security regression test: conversation ownership check in /api/nexus/chat.
 *
 * Verifies that a user cannot append messages to a conversation they do not
 * own by supplying an arbitrary conversationId in the request body. Before the
 * fix, any authenticated user could inject messages into any conversation.
 *
 * Both the standard chat path (setupConversation) and the image-generation
 * path (getOrCreateImageConversation) are covered.
 *
 * Auth requirement: Two distinct authenticated sessions are needed. Set
 * PLAYWRIGHT_AUTH_ENABLED=true and configure storage-state files for each
 * user before running.
 */

test.describe('Nexus conversation ownership (security)', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires two authenticated Playwright contexts — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test('standard chat: POST with another user\'s conversationId returns 404', async ({ browser }) => {
    const userAContext = await browser.newContext({
      storageState: process.env.PLAYWRIGHT_AUTH_STATE_A || 'tests/e2e/.auth/user-a.json'
    })
    const userBContext = await browser.newContext({
      storageState: process.env.PLAYWRIGHT_AUTH_STATE_B || 'tests/e2e/.auth/user-b.json'
    })

    try {
      // Step 1: User A creates a conversation by sending the first message.
      const userAPage = await userAContext.newPage()
      await userAPage.goto('/nexus')
      await userAPage.waitForURL((url) => !url.pathname.includes('/auth/signin'), { timeout: 10_000 })

      // Capture the X-Conversation-Id header from the first response.
      let userAConversationId: string | null = null
      userAPage.on('response', (response) => {
        if (response.url().includes('/api/nexus/chat') && response.status() === 200) {
          const id = response.headers()['x-conversation-id']
          if (id) userAConversationId = id
        }
      })

      const composerInput = userAPage.locator('[aria-label="Message input"]')
      await expect(composerInput).toBeVisible({ timeout: 10_000 })
      await composerInput.fill('Ownership test seed message')
      await userAPage.locator('[aria-label="Send message"]').click()

      // Wait for the conversation ID to appear in the URL or response header.
      await userAPage.waitForFunction(
        () => window.location.pathname.startsWith('/nexus/') && window.location.pathname.length > '/nexus/'.length,
        { timeout: 30_000 }
      )

      if (!userAConversationId) {
        const pathname = new URL(userAPage.url()).pathname
        userAConversationId = pathname.replace('/nexus/', '')
      }

      expect(userAConversationId).toBeTruthy()

      // Step 2: User B attempts to POST to /api/nexus/chat with User A's conversationId.
      const userBRequest = userBContext.request
      const response = await userBRequest.post('/api/nexus/chat', {
        data: {
          messages: [{ id: 'msg-1', role: 'user', content: 'Injected message' }],
          modelId: 'gpt-4o-mini',
          provider: 'openai',
          conversationId: userAConversationId
        },
        headers: { 'Content-Type': 'application/json' }
      })

      // Step 3: Expect 404 — no signal whether the ID is valid or wrong-owner.
      expect(response.status()).toBe(404)
      const body = await response.json()
      expect(body.error).toContain('not found or access denied')
    } finally {
      await userAContext.close()
      await userBContext.close()
    }
  })

  test('image generation: POST with another user\'s conversationId returns 404', async ({ browser }) => {
    const userAContext = await browser.newContext({
      storageState: process.env.PLAYWRIGHT_AUTH_STATE_A || 'tests/e2e/.auth/user-a.json'
    })
    const userBContext = await browser.newContext({
      storageState: process.env.PLAYWRIGHT_AUTH_STATE_B || 'tests/e2e/.auth/user-b.json'
    })

    try {
      // Step 1: User A creates an image-generation conversation.
      const userARequest = userAContext.request
      const createResponse = await userARequest.post('/api/nexus/chat', {
        data: {
          messages: [{ id: 'msg-1', role: 'user', content: 'A red apple on a white table' }],
          modelId: 'dall-e-3',
          provider: 'openai'
        },
        headers: { 'Content-Type': 'application/json' }
      })

      // Image generation may return 200 or stream — extract conversationId from header.
      const userAConversationId = createResponse.headers()['x-conversation-id']
      // Skip if this environment doesn't have image-gen configured.
      test.skip(!userAConversationId, 'Image generation not available in this environment')

      // Step 2: User B attempts to continue User A's image conversation.
      const userBRequest = userBContext.request
      const response = await userBRequest.post('/api/nexus/chat', {
        data: {
          messages: [{ id: 'msg-2', role: 'user', content: 'Now make it blue' }],
          modelId: 'dall-e-3',
          provider: 'openai',
          conversationId: userAConversationId
        },
        headers: { 'Content-Type': 'application/json' }
      })

      // Step 3: Expect 404.
      expect(response.status()).toBe(404)
    } finally {
      await userAContext.close()
      await userBContext.close()
    }
  })
})
