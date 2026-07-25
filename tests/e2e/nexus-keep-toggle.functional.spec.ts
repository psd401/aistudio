import { mkdir } from 'node:fs/promises'
import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'

/**
 * E2E functional coverage for the Nexus "Keep" toggle (Issue #1330).
 *
 * Keep (`nexus_conversations.is_saved`) is what exempts a conversation from the
 * nightly retention sweep's irreversible hard delete, so this proves the flag
 * actually round-trips to the database rather than only flipping in local state:
 *  - create a conversation via POST /api/nexus/conversations
 *  - toggle Keep in the sidebar conversation list
 *  - assert GET /api/nexus/conversations reports isSaved: true AND the "Kept"
 *    indicator is visible
 *  - toggle back off and assert both clear
 *
 * Auth: mints a NextAuth session cookie for the seeded admin
 * (helpers/session-auth). Requires AUTH_SECRET in env and the host :3100 dev
 * server (NOT the prod-built :3000 container, which rejects the non-secure dev
 * cookie). See docs/guides/e2e-authenticated-testing.md. Gated behind
 * PLAYWRIGHT_AUTH_ENABLED so default CI (no seeded session) skips.
 */

interface ConversationPayload {
  id: string
  title: string | null
  isSaved?: boolean
}

test.describe('Nexus Keep toggle (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  test('toggling Keep persists isSaved and shows the kept indicator', async ({ page }, testInfo) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)

    const title = `e2e keep probe ${Date.now()}`
    const created = await page.request.post('/api/nexus/conversations', {
      data: { title, provider: 'openai' },
    })
    expect(created.ok()).toBeTruthy()
    const conversationId: string = (await created.json())?.id
    expect(conversationId).toBeTruthy()

    // Reads the conversation straight from the list API — the same payload the
    // sidebar consumes, so a UI-only flip would fail here.
    const readIsSaved = async (): Promise<boolean | undefined> => {
      const res = await page.request.get('/api/nexus/conversations?limit=500&offset=0')
      expect(res.ok()).toBeTruthy()
      const body = await res.json()
      const match = (body?.conversations as ConversationPayload[] | undefined)?.find(
        (conv) => conv.id === conversationId
      )
      expect(match, 'created conversation should appear in the list payload').toBeTruthy()
      return match?.isSaved
    }

    expect(await readIsSaved()).toBe(false)

    await page.goto('/nexus')

    const row = page.getByTestId(`conversation-item-${conversationId}`)
    await expect(row).toBeVisible({ timeout: 15000 })

    const keepToggle = row.getByTestId('conversation-keep-toggle')
    const keptIndicator = row.getByTestId('conversation-kept-indicator')

    await expect(keepToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(keptIndicator).toHaveCount(0)

    // Toggle ON.
    await keepToggle.click()
    await expect(keepToggle).toHaveAttribute('aria-pressed', 'true', { timeout: 10000 })
    await expect(keptIndicator).toBeVisible({ timeout: 10000 })

    await expect
      .poll(readIsSaved, { timeout: 10000, message: 'isSaved should persist as true' })
      .toBe(true)

    // Visual evidence for the PR (screenshot_dir = .verification).
    await mkdir('.verification', { recursive: true })
    await page.screenshot({
      path: `.verification/nexus-keep-toggle-${testInfo.project.name}.png`,
      fullPage: false,
    })

    // Toggle OFF.
    await keepToggle.click()
    await expect(keepToggle).toHaveAttribute('aria-pressed', 'false', { timeout: 10000 })
    await expect(keptIndicator).toHaveCount(0, { timeout: 10000 })

    await expect
      .poll(readIsSaved, { timeout: 10000, message: 'isSaved should persist as false' })
      .toBe(false)
  })

  test('PATCH rejects a non-boolean isSaved with 400', async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)

    const created = await page.request.post('/api/nexus/conversations', {
      data: { title: `e2e keep validation ${Date.now()}`, provider: 'openai' },
    })
    expect(created.ok()).toBeTruthy()
    const conversationId: string = (await created.json())?.id
    expect(conversationId).toBeTruthy()

    // A truthy string must not silently become "kept" — this flag is the only
    // thing standing between a conversation and irreversible deletion.
    const bad = await page.request.patch(`/api/nexus/conversations/${conversationId}`, {
      data: { isSaved: 'true' },
    })
    expect(bad.status()).toBe(400)

    const res = await page.request.get('/api/nexus/conversations?limit=500&offset=0')
    const body = await res.json()
    const match = (body?.conversations as ConversationPayload[] | undefined)?.find(
      (conv) => conv.id === conversationId
    )
    expect(match?.isSaved).toBe(false)
  })
})
