import fs from "node:fs"
import path from "node:path"

import { agentScheduledRuns } from "@/lib/db/schema"

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "infra/database/schema/188-agent-schedule-owner-notified.sql",
  ),
  "utf8",
)

const registry = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "infra/database/migrations.json"),
    "utf8",
  ),
) as { migrationFiles: string[] }

describe("schedule owner-notified migration (#1890)", () => {
  it("records that the owner was told, rather than inferring it", () => {
    // The suppression has to be a fact. Inferring "already told" from the
    // streak's LENGTH skipped every schedule that was already failing when
    // this shipped — the exact population #1890 was opened for.
    expect(migration).toContain("ALTER TABLE agent_scheduled_runs")
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS owner_notified_at TIMESTAMPTZ",
    )
  })

  it("indexes only the streak-deciding runs, in the readers' order", () => {
    // Partial on the deciding statuses: without the predicate, LIMIT 500 still
    // walks past every skipped/promoted row of a contended schedule.
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_agent_scheduled_runs_streak\s+ON agent_scheduled_runs \(user_id, schedule_id, created_at DESC, id DESC\)\s+WHERE status IN \('success', 'error', 'deferred'\);/,
    )
  })

  it("is registered so the migration Lambda actually runs it", () => {
    // A migration absent from this array is dead text: the column never
    // appears and every read of it fails in production.
    expect(registry.migrationFiles).toContain(
      "188-agent-schedule-owner-notified.sql",
    )
  })

  it("is nullable and additive, so a rollback loses nothing but the stamps", () => {
    expect(migration).not.toMatch(/NOT NULL/)
    expect(migration).toContain(
      "DROP COLUMN IF EXISTS owner_notified_at",
    )
  })

  it("matches the Drizzle model the app reads it through", () => {
    // Schema drift here is silent: the app would select a column the database
    // does not have, or stop reading one it does.
    const columns = Object.keys(agentScheduledRuns)
    expect(columns).toContain("ownerNotifiedAt")
    expect(agentScheduledRuns.ownerNotifiedAt.name).toBe("owner_notified_at")
    expect(agentScheduledRuns.ownerNotifiedAt.notNull).toBe(false)
  })
})
