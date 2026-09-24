import { expect, type Page } from '@playwright/test'

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

// Create a Nexus project through the "New project" dialog and land on its page.
// Returns the new project's id. Both project specs drive this exact flow, so the
// dialog's selectors live in one place.
export async function createNexusProject(
  page: Page,
  input: { name: string; instructions: string; timeout?: number }
): Promise<string> {
  await page.goto('/nexus/projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Project name').fill(input.name)
  await dialog.getByLabel('Project instructions').fill(input.instructions)
  await dialog.getByRole('button', { name: 'Create project' }).click()

  await expect(page).toHaveURL(/\/nexus\/projects\/[0-9a-f-]+$/, {
    timeout: input.timeout ?? 30_000,
  })
  const projectId = page.url().split('/').at(-1) ?? ''
  expect(projectId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  )
  return projectId
}
