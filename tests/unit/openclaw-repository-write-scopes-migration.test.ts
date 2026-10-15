import fs from "node:fs"
import path from "node:path"

import { AISTUDIO_OPENCLAW_SCOPES } from "@/lib/oauth/openclaw-client"
import { API_SCOPES } from "@/lib/api-keys/scopes"

const migrationFile = fs.readFileSync(
  path.join(
    process.cwd(),
    "infra/database/schema/189-openclaw-repository-write-scopes.sql",
  ),
  "utf8",
)

/**
 * The executable SQL only. The header comment carries a full ROLLBACK statement
 * — including its own `SET allowed_scopes` / `WHERE client_id` — so parsing the
 * raw file would read the rollback's pre-change array as if it were the one the
 * migration writes, and every assertion below would pass on the wrong text.
 */
const migration = migrationFile
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")

const registry = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "infra/database/migrations.json"),
    "utf8",
  ),
) as { migrationFiles: string[] }

/** The scope strings the migration writes into `allowed_scopes`, in order. */
function migratedScopes(): string[] {
  const setClause = migration.slice(
    migration.indexOf("SET"),
    migration.indexOf("WHERE client_id"),
  )
  return [...setClause.matchAll(/"([a-z_:]+)"/g)].map((m) => m[1])
}

describe("OpenClaw repository write scopes migration (#1907)", () => {
  it("is registered so the migration Lambda actually runs it", () => {
    // A migration absent from this array is dead text: the client's
    // allowed_scopes never widen and every agent-connect carrying the new
    // scopes is rejected as invalid_scope.
    expect(registry.migrationFiles).toContain(
      "189-openclaw-repository-write-scopes.sql",
    )
  })

  it("widens exactly the first-party OpenClaw client", () => {
    expect(migration).toContain("UPDATE oauth_clients")
    expect(migration).toContain(
      "WHERE client_id = '7e8646f4-4091-4a34-a6b9-0d3721e8a126'",
    )
    expect(migration).toContain("is_first_party = true")
  })

  it("writes exactly the scope list the code requests", () => {
    // Drift here is a silent outage: oidc-provider validates every requested
    // scope against allowed_scopes, so a scope present in
    // AISTUDIO_OPENCLAW_SCOPES but missing from the row fails the whole
    // authorization request, not just that scope.
    expect(migratedScopes()).toEqual([...AISTUDIO_OPENCLAW_SCOPES])
  })

  it("adds the two repository write scopes and keeps the read scopes", () => {
    const scopes = migratedScopes()
    expect(scopes).toContain("repositories:write")
    expect(scopes).toContain("repositories:create")
    for (const kept of [
      "repositories:list",
      "repositories:read",
      "repositories:search",
      "repositories:changes",
      "platform:read",
    ]) {
      expect(scopes).toContain(kept)
    }
  })

  it("keeps the three OIDC scopes the oauth_clients constraint requires", () => {
    // Migration 132 added oauth_clients_public_oidc_scopes; dropping any of
    // these from a public PKCE client's array violates it and the UPDATE fails.
    for (const required of ["openid", "profile", "offline_access"]) {
      expect(migratedScopes()).toContain(required)
    }
  })

  it("only ever requests scopes the platform actually defines", () => {
    for (const scope of migratedScopes()) {
      if (["openid", "profile", "email", "offline_access"].includes(scope)) {
        continue
      }
      expect(Object.keys(API_SCOPES)).toContain(scope)
    }
  })

  it("guards on the exact pre-change array, so an edited client is untouched", () => {
    // Re-running after a successful update, or running against an
    // administrator-modified client, must be a no-op rather than an overwrite.
    const guard = migration.slice(migration.indexOf("WHERE client_id"))
    expect(guard).toContain("allowed_scopes =")
    expect(guard).not.toContain("repositories:write")
    expect(guard).not.toContain("repositories:create")
  })
})
