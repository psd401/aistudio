import postgres from "postgres"
import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { authenticateContext } from "./helpers/session-auth"

/**
 * Admin → Models: an OpenAI GPT model on Bedrock gets a "Default Reasoning
 * Effort" setting, stored in ai_models.provider_metadata.defaultReasoningEffort
 * and read by lib/ai/bedrock-openai.ts when a request does not choose an
 * effort. Other models do not show the setting.
 *
 * No model is called; this only exercises the admin form and its persistence.
 */
const SUFFIX = Date.now().toString(36)
const GPT_MODEL_ID = `us.openai.gpt-e2e-effort-${SUFFIX}`
const GPT_NAME = `GPT Effort E2E ${SUFFIX}`
const CLAUDE_MODEL_ID = `us.anthropic.claude-e2e-effort-${SUFFIX}`
const CLAUDE_NAME = `Claude Effort E2E ${SUFFIX}`

function createDatabase() {
  return postgres(
    process.env.E2E_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/aistudio",
    { ssl: process.env.E2E_DB_SSL === "true" },
  )
}

async function openEditor(page: Page, name: string) {
  await page.goto("/admin/models")
  await page.getByLabel("Search models").fill(name)
  const row = page.getByRole("row").filter({ hasText: name })
  await expect(row).toHaveCount(1, { timeout: 30_000 })
  await row.getByRole("button", { name: "Open menu" }).click()
  await page.getByRole("menuitem", { name: "Edit Model" }).click()
}

async function storedDefault(
  database: ReturnType<typeof createDatabase>,
  modelId: string,
): Promise<string | null> {
  const [row] = await database<{ effort: string | null }[]>`
    SELECT provider_metadata->>'defaultReasoningEffort' AS effort
    FROM ai_models WHERE model_id = ${modelId}
  `
  return row?.effort ?? null
}

test.describe("Admin model default reasoning effort (authenticated)", () => {
  test.describe.configure({ timeout: 180_000 })
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authenticated host dev server",
  )

  test("sets, persists and clears the default for a Bedrock GPT model only", async ({
    page,
  }, testInfo) => {
    const database = createDatabase()
    try {
      await database`
        INSERT INTO ai_models (name, model_id, provider, capabilities, active, nexus_enabled, architect_enabled, provider_metadata)
        VALUES
          (${GPT_NAME}, ${GPT_MODEL_ID}, 'amazon-bedrock', '["chat"]', true, false, false, ${database.json({ modelRouterTier: "light" })}),
          (${CLAUDE_NAME}, ${CLAUDE_MODEL_ID}, 'amazon-bedrock', '["chat"]', true, false, false, '{}')
      `
      await authenticateContext(page.context())

      // Set "None" on the GPT model.
      await openEditor(page, GPT_NAME)
      const field = page.locator("#defaultReasoningEffort")
      await expect(field).toContainText("Model default")
      await field.click()
      await page.getByRole("option", { name: /^None/ }).click()
      await page.screenshot({ path: testInfo.outputPath("effort-none-selected.png"), fullPage: true })
      await page.getByRole("button", { name: "Save Changes" }).click()
      await expect.poll(() => storedDefault(database, GPT_MODEL_ID), { timeout: 30_000 }).toBe("none")

      // Unrelated metadata survives the edit.
      const [kept] = await database<{ tier: string | null }[]>`
        SELECT provider_metadata->>'modelRouterTier' AS tier FROM ai_models WHERE model_id = ${GPT_MODEL_ID}
      `
      expect(kept.tier).toBe("light")

      // Reopen: the saved value is shown; back to "Model default" removes it.
      await openEditor(page, GPT_NAME)
      await expect(page.locator("#defaultReasoningEffort")).toContainText("None")
      await page.locator("#defaultReasoningEffort").click()
      await page.getByRole("option", { name: "Model default" }).click()
      await page.getByRole("button", { name: "Save Changes" }).click()
      await expect.poll(() => storedDefault(database, GPT_MODEL_ID), { timeout: 30_000 }).toBeNull()

      // A Claude model on Bedrock has no such setting.
      await openEditor(page, CLAUDE_NAME)
      await expect(page.getByRole("button", { name: "Save Changes" })).toBeVisible()
      await expect(page.locator("#defaultReasoningEffort")).toHaveCount(0)
    } finally {
      await database`DELETE FROM ai_models WHERE model_id IN (${GPT_MODEL_ID}, ${CLAUDE_MODEL_ID})`
      await database.end()
    }
  })
})
