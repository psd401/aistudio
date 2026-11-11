import fs from "node:fs"
import path from "node:path"

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "infra/database/schema/192-atrium-private-by-default.sql",
  ),
  "utf8",
)

const registry = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "infra/database/migrations.json"),
    "utf8",
  ),
) as { migrationFiles: string[] }

// Executable SQL only: the header's rollback block also mentions `internal`.
const body = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")

describe("Atrium private-by-default migration (#2034)", () => {
  it("is registered so the migration Lambda actually runs it", () => {
    expect(registry.migrationFiles).toContain(
      "192-atrium-private-by-default.sql",
    )
  })

  it("narrows only internal objects, and only to private", () => {
    expect(body).toMatch(/WHERE o\.visibility_level = 'internal'/)
    expect(body).toMatch(/SET visibility_level = 'private'/)
    // Never widens, and never touches group/public objects.
    expect(body).not.toMatch(/visibility_level = '(group|public)'/)
  })

  it("keeps objects someone explicitly widened", () => {
    expect(body).toMatch(
      /NOT EXISTS \([\s\S]*l\.action = 'set_visibility'[\s\S]*l\.outcome = 'ok'/,
    )
  })

  it("records every change as a reversible audit row before updating", () => {
    // The UPDATE reads ids from the audit INSERT's RETURNING, so an object is
    // never narrowed without its rollback record.
    expect(body).toMatch(/INSERT INTO content_audit_logs/)
    expect(body).toMatch(/'previousLevel', 'internal'/)
    expect(body).toMatch(/WHERE id IN \(SELECT object_id FROM logged\)/)
    expect(migration).toContain("-- Rollback (restores only objects that are still `private`")
  })

  it("is a single statement the migration runner executes atomically", () => {
    expect(body.trim().split(";").filter((s) => s.trim()).length).toBe(1)
  })
})
