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

interface ConversationPayload {
  id: string
  metadata?: {
    memoryDisabled?: boolean
  } | null
}

function createDatabase() {
  return postgres(
    process.env.E2E_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/aistudio",
    { ssl: process.env.E2E_DB_SSL === "true" },
  )
}

test.describe("Nexus conversation memory toggle (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authenticated local E2E server and seeded users",
  )

  test("persists memoryDisabled and reflects it in the sidebar", async ({
    page,
  }) => {
    await authenticateContext(
      page.context(),
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB,
    )

    const created = await page.request.post("/api/nexus/conversations", {
      data: {
        title: `e2e memory toggle ${Date.now()}`,
        provider: "openai",
      },
    })
    expect(created.ok()).toBe(true)
    const conversationId = String((await created.json()).id)

    const readMemoryDisabled = async (): Promise<boolean | undefined> => {
      const response = await page.request.get(
        "/api/nexus/conversations?limit=500&offset=0",
      )
      expect(response.ok()).toBe(true)
      const body = (await response.json()) as {
        conversations?: ConversationPayload[]
        memoryControlAvailable?: boolean
      }
      expect(body.memoryControlAvailable).toBe(true)
      return body.conversations?.find(
        (conversation) => conversation.id === conversationId,
      )?.metadata?.memoryDisabled
    }

    expect(await readMemoryDisabled()).not.toBe(true)
    await page.goto("/nexus")

    const row = page.getByTestId(`conversation-item-${conversationId}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    const toggle = row.getByTestId("conversation-memory-toggle")
    const indicator = row.getByTestId("conversation-memory-off-indicator")
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await expect(indicator).toHaveCount(0)

    const expectPatch = async (memoryDisabled: boolean) => {
      const responsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          response.url().includes(
            `/api/nexus/conversations/${conversationId}`,
          ),
        { timeout: 20_000 },
      )
      await toggle.click()
      const response = await responsePromise
      expect(response.request().postDataJSON()).toEqual({ memoryDisabled })
      expect(response.status()).toBe(200)
    }

    await expectPatch(true)
    await expect(toggle).toHaveAttribute("aria-pressed", "false")
    await expect(indicator).toBeVisible()
    await expect
      .poll(readMemoryDisabled, {
        message: "conversation memory should persist as disabled",
      })
      .toBe(true)

    await expectPatch(false)
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await expect(indicator).toHaveCount(0)
    await expect
      .poll(readMemoryDisabled, {
        message: "conversation memory should persist as enabled",
      })
      .toBe(false)
  })

  test("rejects a non-boolean memoryDisabled value", async ({ page }) => {
    await authenticateContext(
      page.context(),
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB,
    )
    const created = await page.request.post("/api/nexus/conversations", {
      data: {
        title: `e2e memory validation ${Date.now()}`,
        provider: "openai",
      },
    })
    expect(created.ok()).toBe(true)
    const conversationId = String((await created.json()).id)

    const response = await page.request.patch(
      `/api/nexus/conversations/${conversationId}`,
      { data: { memoryDisabled: "true" } },
    )
    expect(response.status()).toBe(400)
  })
})

test.describe("Nexus disabled-memory turn (authenticated, live provider)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authenticated local E2E server and seeded users",
  )
  test("a disabled conversation completes normally without writing memory", async ({
    page,
  }) => {
    test.skip(
      process.env.E2E_RUN_EXTERNAL !== "1",
      "Requires a live chat provider (E2E_RUN_EXTERNAL=1)",
    )
    test.setTimeout(180_000)
    await authenticateContext(
      page.context(),
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB,
    )
    const database = createDatabase()
    const marker = `memory-disabled-${Date.now()}`

    try {
      const created = await page.request.post("/api/nexus/conversations", {
        data: {
          title: `e2e memory disabled ${Date.now()}`,
          provider: "openai",
        },
      })
      expect(created.ok()).toBe(true)
      const conversationId = String((await created.json()).id)
      const disabled = await page.request.patch(
        `/api/nexus/conversations/${conversationId}`,
        { data: { memoryDisabled: true } },
      )
      expect(disabled.status()).toBe(200)

      await page.goto(`/nexus?id=${conversationId}`)
      await expect(page.getByTestId("nexus-shell")).toBeVisible({
        timeout: 30_000,
      })
      await sendMessage(
        page,
        `Please remember this using any available memory tool: ${marker}.`,
      )
      await waitForStreamingComplete(page, 120_000)
      await expect(page.locator('[data-role="assistant"]').last()).toBeVisible()

      const rows = await database<{ id: string }[]>`
        SELECT memory.id
        FROM nexus_user_memories memory
        JOIN users owner ON owner.id = memory.user_id
        WHERE owner.email = ${SEEDED_ADMIN_EMAIL}
          AND memory.deleted_at IS NULL
          AND memory.content LIKE ${`%${marker}%`}
      `
      expect(rows).toHaveLength(0)
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
