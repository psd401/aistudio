import postgres from "postgres"
import { test, expect } from "./fixtures"
import { authenticateContext } from "./helpers/session-auth"
import {
  getConversationIdFromUrl,
  gotoNexus,
  sendMessage,
  waitForStreamingComplete,
} from "./nexus/utils"

/**
 * An OpenAI GPT model hosted on Amazon Bedrock answers a Nexus conversation
 * through the Responses API on bedrock-runtime (`lib/ai/bedrock-openai.ts`),
 * across two turns — the second replays the first turn's history, which is
 * where a stateless (`store: false`) Responses request could break.
 *
 * Live: calls Bedrock with the server's Bedrock credentials. The model is
 * picked in the composer, so the router must be off locally, otherwise the
 * pick is only a fallback and the router may answer with another model.
 */
const MODEL_ID = "us.openai.gpt-5.5"
const MODEL_NAME = "GPT-5.5 (Bedrock E2E)"

function createDatabase() {
  return postgres(
    process.env.E2E_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/aistudio",
    { ssl: process.env.E2E_DB_SSL === "true" },
  )
}

async function assistantModelIds(
  database: ReturnType<typeof createDatabase>,
  conversationId: string,
): Promise<Array<number | null>> {
  const rows = await database<{ model_id: number | null }[]>`
    SELECT model_id FROM nexus_messages
    WHERE conversation_id = ${conversationId} AND role = 'assistant'
    ORDER BY created_at
  `
  return rows.map((row) => row.model_id)
}

test.describe("Nexus chat on a Bedrock-hosted GPT model (authenticated)", () => {
  test.describe.configure({ timeout: 300_000 })
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true" ||
      process.env.E2E_RUN_EXTERNAL !== "1",
    "Requires authenticated local E2E plus live Bedrock credentials",
  )

  test("answers two turns and records the Bedrock GPT model on each reply", async ({
    page,
  }, testInfo) => {
    const database = createDatabase()
    try {
      const [router] = await database<{ value: string | null }[]>`
        SELECT value FROM settings WHERE key = 'NEXUS_ROUTER_MODE'
      `
      test.skip(
        (router?.value ?? "off") !== "off",
        "NEXUS_ROUTER_MODE must be 'off' so the composer's model pick is honoured",
      )

      const [model] = await database<{ id: number }[]>`
        INSERT INTO ai_models (name, model_id, provider, capabilities, active, nexus_enabled, architect_enabled)
        VALUES (
          ${MODEL_NAME}, ${MODEL_ID}, 'amazon-bedrock',
          '["chat", "function_calling", "image_analysis", "streaming", "reasoning"]',
          true, true, true
        )
        ON CONFLICT (model_id) DO UPDATE
          SET active = true, nexus_enabled = true, provider = 'amazon-bedrock'
        RETURNING id
      `

      // Nexus has no per-model picker (only a family selector); the composer's
      // model is the one persisted by `useModelPersistence('nexus-model')`.
      const storedModel = {
        id: model.id,
        modelId: MODEL_ID,
        name: MODEL_NAME,
        provider: "amazon-bedrock",
        active: true,
        nexusEnabled: true,
      }
      await page.addInitScript((stored) => {
        window.localStorage.setItem("nexus-modelId", stored.modelId)
        window.localStorage.setItem("nexus-modelData", JSON.stringify(stored))
      }, storedModel)

      await authenticateContext(page.context())
      await gotoNexus(page)

      await sendMessage(page, "Reply with exactly the single word PELICAN and nothing else.")
      await waitForStreamingComplete(page, 180_000)
      const first = page.locator('[data-role="assistant"]').last()
      await expect(first).toContainText("PELICAN", { timeout: 60_000 })

      await sendMessage(
        page,
        "What single word did you just reply with? Answer with that word in lowercase only.",
      )
      await waitForStreamingComplete(page, 180_000)
      const second = page.locator('[data-role="assistant"]').last()
      await expect(second).toContainText("pelican", { timeout: 60_000 })

      const conversationId = getConversationIdFromUrl(page)
      expect(conversationId).toBeTruthy()
      await expect
        .poll(() => assistantModelIds(database, conversationId!), {
          timeout: 30_000,
          message: "both replies should be persisted with the Bedrock GPT model",
        })
        .toEqual([model.id, model.id])

      await page.screenshot({
        path: testInfo.outputPath("nexus-bedrock-openai.png"),
        fullPage: true,
      })
    } finally {
      await database.end()
    }
  })
})
