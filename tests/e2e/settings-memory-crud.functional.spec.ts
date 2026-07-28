import postgres from "postgres"
import { test, expect } from "./fixtures"
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth"

interface MemoryRow {
  id: string
  content: string
  source: string
  deleted_at: Date | null
}

function createDatabase() {
  return postgres(
    process.env.E2E_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/aistudio",
    { ssl: process.env.E2E_DB_SSL === "true" },
  )
}

test.describe("Settings memory CRUD (authenticated)", () => {
  test.describe.configure({ timeout: 180_000 })
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true" ||
      process.env.E2E_RUN_EXTERNAL !== "1",
    "Requires authenticated local E2E plus the live memory safety and embedding services",
  )

  test("adds, edits, verifies, and bulk-deletes memories through the real UI", async ({
    page,
  }) => {
    await authenticateContext(
      page.context(),
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB,
    )
    const database = createDatabase()
    const marker = `settings-memory-${Date.now()}`
    const firstContent = `${marker}-one: I prefer compact meeting summaries.`
    const editedContent = `${marker}-one-edited: I prefer one-paragraph meeting summaries.`
    const secondContent = `${marker}-two: My current project is a curriculum review.`

    try {
      await page.goto("/settings")
      await page.getByRole("tab", { name: "Memory" }).click()
      await expect(
        page.getByRole("heading", { name: "Nexus memory" }),
      ).toBeVisible()

      await page.getByTestId("memory-add-open").click()
      await expect(page.getByTestId("memory-add-save")).toBeDisabled()
      await page.getByTestId("memory-add-content").fill(firstContent)
      await page.getByTestId("memory-add-save").click()

      const firstRow = page
        .getByTestId("memory-row")
        .filter({ hasText: firstContent })
      await expect(firstRow).toBeVisible({ timeout: 30_000 })
      await expect(firstRow.getByText("Manual")).toBeVisible()
      await expect(firstRow.getByText("context")).toBeVisible()

      await firstRow
        .getByRole("button", { name: `Edit memory: ${firstContent}` })
        .click()
      await firstRow.getByTestId("memory-edit-content").fill(editedContent)
      await firstRow.getByTestId("memory-edit-save").click()

      const editedRow = page
        .getByTestId("memory-row")
        .filter({ hasText: editedContent })
      await expect(editedRow).toBeVisible({ timeout: 30_000 })
      await expect(
        page.getByTestId("memory-row").filter({ hasText: firstContent }),
      ).toHaveCount(0)

      await page.getByTestId("memory-add-open").click()
      await page.getByTestId("memory-add-content").fill(secondContent)
      await page.getByTestId("memory-add-save").click()
      const secondRow = page
        .getByTestId("memory-row")
        .filter({ hasText: secondContent })
      await expect(secondRow).toBeVisible({ timeout: 30_000 })

      await editedRow
        .getByRole("checkbox", {
          name: `Select memory: ${editedContent}`,
        })
        .click()
      await secondRow
        .getByRole("checkbox", {
          name: `Select memory: ${secondContent}`,
        })
        .click()
      await page.getByTestId("memory-bulk-delete").click()
      await page.getByTestId("memory-delete-confirm").click()

      await expect(
        page.getByTestId("memory-row").filter({ hasText: marker }),
      ).toHaveCount(0, { timeout: 30_000 })

      const rows = await database<MemoryRow[]>`
        SELECT memory.id, memory.content, memory.source, memory.deleted_at
        FROM nexus_user_memories memory
        JOIN users owner ON owner.id = memory.user_id
        WHERE owner.email = ${SEEDED_ADMIN_EMAIL}
          AND memory.content LIKE ${`%${marker}%`}
        ORDER BY memory.created_at
      `
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.source)).toEqual([
        "manual",
        "manual",
      ])
      expect(rows.every((row) => row.deleted_at !== null)).toBe(true)
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
