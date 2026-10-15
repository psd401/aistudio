import fs from "node:fs"
import path from "node:path"

const migrationPath = path.join(
  process.cwd(),
  "infra/database/schema/190-atrium-capture-execute-scope.sql",
)
const migration = fs.readFileSync(migrationPath, "utf8")

const registry = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "infra/database/migrations.json"),
    "utf8",
  ),
) as { migrationFiles: string[] }

describe("Atrium Capture execute scope migration", () => {
  it("adds assistants:execute to only the two exact first-party clients", () => {
    expect(migration).toContain("ae781263-20c0-4b0c-8a34-8be01ab72fb1")
    expect(migration).toContain("fbdaa815-1b0f-435b-805f-1732805720c1")
    expect(migration).toContain("is_first_party = true")
    expect(migration).toContain("token_endpoint_auth_method = 'none'")
    expect(migration).toContain("require_pkce = true")
    expect(migration).toContain("'\"assistants:execute\"'::jsonb")
    expect(migration).not.toContain("client_name =")
  })

  it("is idempotent and registered", () => {
    expect(migration).toContain("NOT allowed_scopes ? 'assistants:execute'")
    expect(registry.migrationFiles.at(-1)).toBe(
      "190-atrium-capture-execute-scope.sql",
    )
  })
})
