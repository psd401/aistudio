import postgres from "postgres"
import { test, expect } from "./fixtures"
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth"

interface ImportedMemoryRow {
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

test.describe("Settings memory import (authenticated)", () => {
  test.describe.configure({ timeout: 240_000 })
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true" ||
      process.env.E2E_RUN_EXTERNAL !== "1",
    "Requires authenticated local E2E plus the live extraction, safety, and embedding services",
  )

  test("extracts a paste for review, omits a deselected candidate, and saves edited candidates", async ({
    page,
  }) => {
    await authenticateContext(
      page.context(),
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB,
    )
    const database = createDatabase()
    const marker = `settings-memory-import-${Date.now()}`
    const pastedText = [
      "- I work in a school district technology team.",
      "- I prefer concise answers with a short summary.",
      "- My ongoing goal is to improve curriculum review workflows.",
    ].join("\n")

    try {
      await page.goto("/settings")
      await page.getByRole("tab", { name: "Memory" }).click()
      await page.getByTestId("memory-import-open").click()

      await expect(page.getByTestId("memory-import-extract")).toBeDisabled()
      await page.getByTestId("memory-import-paste").fill(pastedText)
      await page.getByTestId("memory-import-extract").click()

      const candidates = page.getByTestId("memory-import-candidate")
      await expect(candidates).toHaveCount(3, { timeout: 90_000 })
      await expect(
        page.getByText(/No memory has been written yet/),
      ).toBeVisible()

      await page
        .getByTestId("memory-import-candidate-select-1")
        .click()
      await page
        .getByTestId("memory-import-candidate-content-0")
        .fill(`${marker}-first: I work in district technology.`)
      await page
        .getByTestId("memory-import-candidate-content-2")
        .fill(
          `${marker}-third: My ongoing goal is improving curriculum review.`,
        )
      await expect(page.getByTestId("memory-import-save")).toHaveText(
        "Import 2 memories",
      )
      await page.getByTestId("memory-import-save").click()

      const importedRows = page
        .getByTestId("memory-row")
        .filter({ hasText: marker })
      await expect(importedRows).toHaveCount(2, { timeout: 90_000 })
      await expect(
        importedRows.filter({ hasText: "ChatGPT import" }),
      ).toHaveCount(2)

      const rows = await database<ImportedMemoryRow[]>`
        SELECT memory.content, memory.source, memory.deleted_at
        FROM nexus_user_memories memory
        JOIN users owner ON owner.id = memory.user_id
        WHERE owner.email = ${SEEDED_ADMIN_EMAIL}
          AND memory.content LIKE ${`%${marker}%`}
        ORDER BY memory.created_at
      `
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.source === "import:chatgpt")).toBe(true)
      expect(rows.every((row) => row.deleted_at === null)).toBe(true)
      expect(
        rows.some((row) => row.content.includes("concise answers")),
      ).toBe(false)
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
