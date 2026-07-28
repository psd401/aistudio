/** @jest-environment node */

import fs from "node:fs"
import path from "node:path"

describe("migration 164 Nexus memory extraction model", () => {
  const migrationName = "164-nexus-memory-extraction-model.sql"
  const migration = fs.readFileSync(
    path.join(process.cwd(), "infra/database/schema", migrationName),
    "utf8",
  )
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "infra/database/migrations.json"),
      "utf8",
    ),
  ) as { migrationFiles: string[] }

  it("registers the settings-only additive migration after 163", () => {
    const previousIndex = manifest.migrationFiles.indexOf(
      "163-assistant-execution-deadline.sql",
    )
    expect(manifest.migrationFiles[previousIndex + 1]).toBe(migrationName)
    expect(migration).toContain("'MEMORY_EXTRACTION_MODEL_ID'")
    expect(migration).toContain("'us.amazon.nova-lite-v1:0'")
    expect(migration).toContain("ON CONFLICT (key) DO NOTHING")
    expect(migration).not.toMatch(/\bTRUNCATE\b/i)
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i)
  })
})
