import { type Page } from '@playwright/test'

/** Navigate to /nexus and verify we're not redirected to auth. */
export async function gotoNexus(page: Page): Promise<void> {
  await page.goto('/nexus')
  await page.waitForURL((url) => !url.pathname.includes('/auth/signin') && !url.pathname.includes('/sign-in'), {
    timeout: 10_000,
  })
  await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })
}

/** Fill and send a message via the composer. */
export async function sendMessage(page: Page, message: string): Promise<void> {
  const input = page.locator('[aria-label="Message input"]')
  await input.fill(message)
  await page.locator('[aria-label="Send message"]').click()
}

/** Wait for the active streaming response to complete (stop button disappears). */
export async function waitForStreamingComplete(page: Page, timeout = 60_000): Promise<void> {
  await page.locator('[aria-label="Stop generating"]').waitFor({ state: 'hidden', timeout })
}

/** Extract the conversation ID from the current URL (/nexus/<id>). Returns null if not on a conversation URL. */
export function getConversationIdFromUrl(page: Page): string | null {
  const pathname = new URL(page.url()).pathname
  const match = pathname.match(/^\/nexus\/(.+)$/)
  return match ? match[1] : null
}

/** Check whether we have an authenticated session by looking for the nexus shell. */
export async function isAuthenticated(page: Page): Promise<boolean> {
  await page.goto('/nexus')
  try {
    await page.waitForURL((url) => !url.pathname.includes('/sign-in'), { timeout: 5_000 })
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}
