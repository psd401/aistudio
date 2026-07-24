import fs from "fs"
import path from "path"

const migrationPath = path.join(
  process.cwd(),
  "infra/database/schema/132-oauth-public-client-scopes.sql"
)
const migration = fs.readFileSync(migrationPath, "utf8")

describe("public OAuth client scope migration", () => {
  it("repairs secretless PKCE authorization-code clients in place", () => {
    expect(migration).toContain("UPDATE oauth_clients")
    expect(migration).toContain("token_endpoint_auth_method = 'none'")
    expect(migration).toContain("require_pkce = true")
    expect(migration).toContain(`grant_types @> '["authorization_code"]'::jsonb`)
    for (const scope of ["openid", "profile", "offline_access"]) {
      expect(migration).toContain(`allowed_scopes ? '${scope}'`)
    }
  })

  it("adds a database invariant for all three required scopes", () => {
    expect(migration).toContain("ADD CONSTRAINT oauth_clients_public_oidc_scopes")
    expect(migration).toContain(
      `allowed_scopes @> '["openid", "profile", "offline_access"]'::jsonb`
    )
  })
})
