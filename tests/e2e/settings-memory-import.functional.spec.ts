import type { Page } from "@playwright/test"
import postgres from "postgres"
import { test, expect } from "./fixtures"
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth"

// Synthetic throughout. These strings are sent to live Comprehend and appear
// in test source and CI output, so no real person's contact details belong in
// them — a fabricated address trips EMAIL detection just as well.
const PII_CANDIDATE_TEXT = [
  "My wife Sarah teaches third grade at Harbor Ridge.",
  "My daughter Ellie is 8 years old.",
  "I started as CIO on July 1, 2019.",
  "My work email is jordan.rivera@example.com.",
] as const

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

async function openMemoryImport(page: Page): Promise<void> {
  await authenticateContext(
    page.context(),
    SEEDED_ADMIN_EMAIL,
    SEEDED_ADMIN_SUB,
  )
  await page.goto("/settings")
  await page.getByRole("tab", { name: "Memory" }).click()
  await page.getByTestId("memory-import-open").click()
}

async function deleteMarkedMemories(
  database: ReturnType<typeof createDatabase>,
  marker: string,
): Promise<void> {
  await database`
    DELETE FROM nexus_user_memories AS memory
    USING users AS owner
    WHERE owner.id = memory.user_id
      AND owner.email = ${SEEDED_ADMIN_EMAIL}
      AND memory.content LIKE ${`%${marker}%`}
  `
  await database.end()
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
    const database = createDatabase()
    const marker = `settings-memory-import-${Date.now()}`
    const pastedText = [
      "- I work in a school district technology team.",
      "- I prefer concise answers with a short summary.",
      "- My ongoing goal is to improve curriculum review workflows.",
    ].join("\n")

    try {
      await openMemoryImport(page)

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
      await deleteMarkedMemories(database, marker)
    }
  })

  test("imports memories that contain names, dates, and ages", async ({
    page,
  }) => {
    const database = createDatabase()
    const marker = `settings-memory-import-pii-${Date.now()}`
    // Every one of these trips Comprehend (NAME, DATE_TIME, AGE, EMAIL). Before
    // the 2026-08-05 fix the save gate refused all four and the user was told
    // only that they "need attention".
    const pastedText = [
      "- My wife Sarah teaches third grade at Harbor Ridge.",
      "- My daughter Ellie is 8 years old.",
      "- I started as CIO on July 1, 2019.",
      "- My work email is jordan.rivera@example.com.",
    ].join("\n")

    try {
      await openMemoryImport(page)
      await page.getByTestId("memory-import-paste").fill(pastedText)
      await page.getByTestId("memory-import-extract").click()

      // How many candidates the model returns is its own call, so this asserts
      // a floor and then pins the saved set itself: the first four rows are
      // overwritten with the PII under test and everything after is deselected.
      const candidates = page.getByTestId("memory-import-candidate")
      await expect(candidates.first()).toBeVisible({ timeout: 90_000 })
      await expect
        .poll(() => candidates.count(), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(PII_CANDIDATE_TEXT.length)

      const extracted = await candidates.count()
      const surplus = Array.from(
        { length: Math.max(0, extracted - PII_CANDIDATE_TEXT.length) },
        (_value, offset) => PII_CANDIDATE_TEXT.length + offset,
      )
      for (const index of surplus) {
        await page
          .getByTestId(`memory-import-candidate-select-${index}`)
          .click()
      }
      for (const [index, text] of PII_CANDIDATE_TEXT.entries()) {
        await page
          .getByTestId(`memory-import-candidate-content-${index}`)
          .fill(`${marker}-${index}: ${text}`)
      }
      await page.getByTestId("memory-import-save").click()

      const importedRows = page
        .getByTestId("memory-row")
        .filter({ hasText: marker })
      await expect(importedRows).toHaveCount(4, { timeout: 90_000 })
      // No candidate is left behind explaining itself.
      await expect(
        page.getByTestId("memory-import-candidate-reason-0"),
      ).toHaveCount(0)

      const rows = await database<ImportedMemoryRow[]>`
        SELECT memory.content, memory.source, memory.deleted_at
        FROM nexus_user_memories memory
        JOIN users owner ON owner.id = memory.user_id
        WHERE owner.email = ${SEEDED_ADMIN_EMAIL}
          AND memory.content LIKE ${`%${marker}%`}
      `
      expect(rows).toHaveLength(4)
      expect(rows.some((row) => row.content.includes("Sarah"))).toBe(true)
      expect(rows.some((row) => row.content.includes("8 years old"))).toBe(
        true,
      )
      expect(
        rows.some((row) => row.content.includes("jordan.rivera@example.com")),
      ).toBe(true)
    } finally {
      await deleteMarkedMemories(database, marker)
    }
  })
})
