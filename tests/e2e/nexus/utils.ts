import { type Page } from '@playwright/test'

// Navigate to /nexus and wait for the shell; throws with a targeted error if redirected to auth.
export async function gotoNexus(page: Page): Promise<void> {
  await page.goto('/nexus')
  try {
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })
  } catch {
    const url = page.url()
    if (url.includes('/auth/signin') || url.includes('/sign-in') || url.includes('/login')) {
      throw new Error(`gotoNexus: unauthenticated — redirected to ${url}`)
    }
    throw new Error(`gotoNexus: nexus shell not found within 10s. Current URL: ${url}`)
  }
}

// Navigate directly to an existing conversation via /nexus?id=<id> — a full page
// load (not client-side routing) exercises ConversationInitializer's initial-mount
// fetch path. Throws with a targeted error if redirected to auth.
export async function gotoNexusConversation(page: Page, conversationId: string): Promise<void> {
  await page.goto(`/nexus?id=${conversationId}`)
  try {
    await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })
  } catch {
    const url = page.url()
    if (url.includes('/auth/signin') || url.includes('/sign-in') || url.includes('/login')) {
      throw new Error(`gotoNexusConversation: unauthenticated — redirected to ${url}`)
    }
    throw new Error(`gotoNexusConversation: nexus shell not found within 10s. Current URL: ${url}`)
  }
}

// Fill and send a message via the composer.
export async function sendMessage(page: Page, message: string): Promise<void> {
  const input = page.locator('[aria-label="Message input"]')
  await input.fill(message)
  await page.locator('[aria-label="Send message"]').click()
}

// Wait for streaming to complete: stop button must appear then disappear.
// If streaming finishes before this is called the try-block no-ops and we wait on hidden.
export async function waitForStreamingComplete(page: Page, timeout = 60_000): Promise<void> {
  const stopBtn = page.locator('[aria-label="Stop generating"]')
  try {
    await stopBtn.waitFor({ state: 'visible', timeout: 15_000 })
  } catch {
    // Streaming completed before stop button appeared — already hidden, proceed
  }
  await stopBtn.waitFor({ state: 'hidden', timeout })
}

// Extract the conversation ID from the /nexus?id= query param. Returns null if not on a conversation URL.
export function getConversationIdFromUrl(page: Page): string | null {
  return new URL(page.url()).searchParams.get('id')
}
