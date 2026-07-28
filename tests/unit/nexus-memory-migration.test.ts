/** @jest-environment node */

import fs from "node:fs"
import path from "node:path"
import { CAPABILITY_MANIFEST } from "@/lib/capabilities/manifest"

describe("migration 162 Nexus user memory", () => {
  const migrationName = "162-nexus-user-memories.sql"
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

  it("registers the additive owner-scoped table and required live indexes", () => {
    expect(manifest.migrationFiles.at(-1)).toBe(migrationName)
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS nexus_user_memories")
    expect(migration).toContain(
      "REFERENCES users(id) ON DELETE CASCADE",
    )
    expect(migration).toContain(
      "REFERENCES nexus_conversations(id) ON DELETE SET NULL",
    )
    expect(migration).toContain("embedding               vector(512)")
    expect(migration).toContain("USING hnsw (embedding vector_cosine_ops)")
    expect(migration).toMatch(/WHERE deleted_at IS NULL/g)
    expect(migration).toContain(
      "EXECUTE FUNCTION update_updated_at_column()",
    )
    expect(migration).not.toMatch(/\bTRUNCATE\b/i)
  })

  it("seeds the independent memory settings with the required defaults", () => {
    expect(migration).toContain("'NEXUS_MEMORY_ENABLED'")
    expect(migration).toContain("'MEMORY_EMBEDDING_MODEL_ID'")
    expect(migration).toContain("'amazon.titan-embed-text-v2:0'")
    expect(migration).toContain("'MEMORY_EMBEDDING_DIMENSIONS'")
    expect(migration).toContain("'MEMORY_RETRIEVAL_THRESHOLD'")
    expect(migration).toContain("'MEMORY_RETRIEVAL_TOP_K'")
    expect(migration).toContain("'0.3'")
    expect(migration).toContain("'6'")
  })

  it("registers nexus-memory for administrator, staff, and student", () => {
    const capability = CAPABILITY_MANIFEST.find(
      (entry) => entry.identifier === "nexus-memory",
    )
    expect(capability).toBeDefined()
    expect(capability?.defaultRoles).toEqual([
      "administrator",
      "staff",
      "student",
    ])
  })
})
