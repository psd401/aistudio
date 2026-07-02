import { test, expect } from './fixtures'
import { authenticateContext } from './helpers/session-auth'
import { gotoNexus, gotoNexusConversation, sendMessage, waitForStreamingComplete, getConversationIdFromUrl } from './nexus/utils'

/**
 * Regression test for #1067 (FS#151602) and its re-occurrence #811.
 *
 * #1067: loading a previous Nexus conversation by ID spun indefinitely on AWS.
 * Root cause: `ConversationInitializer` never fetched/passed `initialMessages`
 * for an existing conversation before PR #489. #811: after that fix, the
 * component's useEffect depended on the `session` object (a new reference on
 * every NextAuth refetch), causing a re-mount/spinner on tab focus. Both fixes
 * are in place (session-provider.tsx `refetchOnWindowFocus={false}`;
 * conversation-initializer.tsx effect deps use `status`, not `session`), but
 * no E2E test covered the exact scenario that caused the original bug —
 * this fills that gap. See docs/features/nexus-conversation-architecture.md
 * "Testing Checklist" and "Pitfall 7".
 */
test.describe('Nexus conversation reload (regression #1067, #811)', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  test('messages persist and load after navigating away and returning via ?id=', async ({ page }) => {
    await gotoNexus(page)

    const testMsg = `E2E reload regression test ${Date.now()}`
    await sendMessage(page, testMsg)
    await waitForStreamingComplete(page)

    await page.waitForURL(
      (url) => url.pathname === '/nexus' && url.searchParams.get('id') !== null,
      { timeout: 20_000 }
    )
    const conversationId = getConversationIdFromUrl(page)
    expect(conversationId).toBeTruthy()

    const assistantBubbles = page.locator('[data-role="assistant"]')
    await expect(assistantBubbles).toHaveCount(1)
    const originalAssistantText = (await assistantBubbles.first().textContent())?.trim() ?? ''
    expect(originalAssistantText.length).toBeGreaterThan(0)

    // Navigate away — a fresh /nexus with no id (like clicking "Start new chat").
    await gotoNexus(page)
    expect(getConversationIdFromUrl(page)).toBeNull()

    // Return via ?id= — a full page load, exercising ConversationInitializer's
    // initial-mount fetch path. This is the exact scenario that regressed in #1067/#811.
    await gotoNexusConversation(page, conversationId!)

    // The loading spinner must not persist indefinitely.
    await expect(page.getByText('Loading conversation...')).not.toBeVisible({ timeout: 15_000 })

    // Original user + assistant messages are visible — not empty/stuck spinning.
    await expect(page.locator('[data-role="user"]').filter({ hasText: testMsg })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(1)
    const reloadedAssistantText = (await page.locator('[data-role="assistant"]').first().textContent())?.trim() ?? ''
    expect(reloadedAssistantText.length).toBeGreaterThan(0)
  })
})
