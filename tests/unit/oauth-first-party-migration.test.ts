import fs from "node:fs"
import path from "node:path"

const migrationPath = path.join(
  process.cwd(),
  "infra/database/schema/134-oauth-first-party-clients.sql"
)
const migration = fs.readFileSync(migrationPath, "utf8")

describe("first-party OAuth client migration", () => {
  it("adds a default-deny trust flag and public-client security invariant", () => {
    expect(migration).toContain(
      "is_first_party BOOLEAN NOT NULL DEFAULT false"
    )
    expect(migration).toContain(
      "ADD CONSTRAINT oauth_clients_first_party_security"
    )
    expect(migration).toContain("token_endpoint_auth_method = 'none'")
    expect(migration).toContain("client_secret_hash IS NULL")
    expect(migration).toContain("require_pkce = true")
  })

  it("backfills only the two exact Atrium Capture client registrations", () => {
    expect(migration).toContain(
      "ae781263-20c0-4b0c-8a34-8be01ab72fb1"
    )
    expect(migration).toContain(
      "fbdaa815-1b0f-435b-805f-1732805720c1"
    )
    expect(migration).toContain(
      "https://jldnpmcpimhabiphcglkbgmbffpoocpo.chromiumapp.org/atrium"
    )
    expect(migration).toContain(
      "org.psd401.atrium-capture:/oauth/callback"
    )
    expect(migration).not.toContain("client_name =")
  })

  it("writes the backfill audit and installs upsert-safe audit triggers", () => {
    expect(migration).toContain("oauth_client_trust_audit")
    expect(migration).toContain(
      "migration-134-exact-atrium-capture-backfill"
    )
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION audit_oauth_client_first_party_insert()"
    )
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION audit_oauth_client_first_party_update()"
    )
    expect(migration).toContain(
      "CREATE TRIGGER trg_oauth_client_trust_audit_insert"
    )
    expect(migration).toContain(
      "CREATE TRIGGER trg_oauth_client_trust_audit_update"
    )
    expect(migration).toContain(
      "WHEN (NEW.is_first_party IS DISTINCT FROM OLD.is_first_party)"
    )
    expect(migration).toContain(
      "DROP RULE IF EXISTS oauth_client_trust_audit_update"
    )
    expect(migration).not.toContain(
      "CREATE OR REPLACE RULE oauth_client_trust_audit"
    )
  })
})
