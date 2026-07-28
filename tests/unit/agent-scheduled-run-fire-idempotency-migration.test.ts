import fs from "node:fs"
import path from "node:path"

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "infra/database/schema/164-agent-scheduled-run-fire-idempotency.sql",
  ),
  "utf8",
)

describe("scheduled-run fire idempotency migration", () => {
  it("adds immutable fire identity to primary and mirrored telemetry", () => {
    expect(migration).toContain(
      "ALTER TABLE agent_scheduled_runs",
    )
    expect(migration).toContain(
      "ALTER TABLE agent_failures",
    )
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS fire_key VARCHAR(192)",
    )
  })

  it("enforces one run and one mirrored failure per immutable fire", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_scheduled_runs_fire[\s\S]+ON agent_scheduled_runs \(fire_key\)[\s\S]+WHERE fire_key IS NOT NULL/,
    )
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_failures_source_fire[\s\S]+ON agent_failures \(source, fire_key\)[\s\S]+WHERE fire_key IS NOT NULL/,
    )
  })
})
