import postgres from "postgres"
import { test, expect } from "./fixtures"
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth"
import {
  sendMessage,
  waitForStreamingComplete,
} from "./nexus/utils"

interface MemoryRow {
  id: string
  source: string
  source_conversation_id: string | null
}

function createDatabase() {
  return postgres(
    process.env.E2E_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/aistudio",
    { ssl: process.env.E2E_DB_SSL === "true" },
  )
}

test.describe("Nexus saveMemory tool (authenticated, live provider)", () => {
  test.describe.configure({ timeout: 180_000 })
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true" ||
      process.env.E2E_RUN_EXTERNAL !== "1",
    "Requires authenticated local E2E plus a live chat provider (E2E_RUN_EXTERNAL=1)",
  )

  test("an explicit remember request is saved through the bound tool", async ({
    page,
  }) => {
    await authenticateContext(
      page.context(),
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB,
    )
    const database = createDatabase()
    const marker = `memory-tool-${Date.now()}`

    try {
      const created = await page.request.post("/api/nexus/conversations", {
        data: {
          title: `e2e memory save ${Date.now()}`,
          provider: "openai",
        },
      })
      expect(created.ok()).toBe(true)
      const conversationId = String((await created.json()).id)

      await page.goto(`/nexus?id=${conversationId}`)
      await expect(page.getByTestId("nexus-shell")).toBeVisible({
        timeout: 30_000,
      })
      await sendMessage(
        page,
        `Please remember this exact durable preference using the saveMemory tool: ${marker} means I prefer concise answers.`,
      )
      await waitForStreamingComplete(page, 120_000)
      await expect(page.locator('[data-role="assistant"]').last()).toBeVisible()

      const findRows = async (): Promise<MemoryRow[]> =>
        database<MemoryRow[]>`
          SELECT memory.id, memory.source, memory.source_conversation_id
          FROM nexus_user_memories memory
          JOIN users owner ON owner.id = memory.user_id
          WHERE owner.email = ${SEEDED_ADMIN_EMAIL}
            AND memory.deleted_at IS NULL
            AND memory.content LIKE ${`%${marker}%`}
        `

      await expect
        .poll(async () => (await findRows()).length, {
          timeout: 30_000,
          message: "saveMemory should persist one live owner-scoped row",
        })
        .toBe(1)
      const [row] = await findRows()
      expect(row.source).toBe("tool")
      expect(row.source_conversation_id).toBe(conversationId)
    } finally {
      await database`
        DELETE FROM nexus_user_memories AS memory
        USING users AS owner
        WHERE owner.id = memory.user_id
          AND owner.email = ${SEEDED_ADMIN_EMAIL}
          AND memory.content LIKE ${`%${marker}%`}
      `
      await database.end()
    }
  })

})
