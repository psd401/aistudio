import fs from "node:fs"
import path from "node:path"

const migrationPath = path.join(
  process.cwd(),
  "infra/database/schema/138-atrium-capture-browser-registration.sql"
)
const migration = fs.readFileSync(migrationPath, "utf8")

describe("Atrium Capture browser registration migration", () => {
  it("replaces the exact old callback for the existing browser client", () => {
    expect(migration).toContain(
      "ae781263-20c0-4b0c-8a34-8be01ab72fb1"
    )
    expect(migration).toContain(
      "https://jldnpmcpimhabiphcglkbgmbffpoocpo.chromiumapp.org/atrium"
    )
    expect(migration).toContain(
      "https://eomlblaiglafndhplfhilmdcaofhkkbj.chromiumapp.org/atrium"
    )
  })

  it("requires the trusted public-PKCE browser profile", () => {
    expect(migration).toContain("application_type = 'browser_extension'")
    expect(migration).toContain("token_endpoint_auth_method = 'none'")
    expect(migration).toContain("client_secret_hash IS NULL")
    expect(migration).toContain("require_pkce = true")
    expect(migration).toContain("is_first_party = true")
    expect(migration).toContain("is_active = true")
  })
})
