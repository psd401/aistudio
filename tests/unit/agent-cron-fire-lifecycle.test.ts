import fs from "node:fs"
import path from "node:path"
import { stripComments } from "../helpers/strip-ts-comments"

const source = stripComments(
  fs.readFileSync(
    path.join(process.cwd(), "infra/lambdas/agent-cron/index.ts"),
    "utf8",
  ),
)

describe("agent-cron fire lifecycle", () => {
  it("releases claims only while execution is still retryable", () => {
    const start = source.indexOf("async function runGuardedScheduleTurn(")
    const end = source.indexOf("export async function handler(", start)
    const lifecycle = source.slice(start, end)
    const release = lifecycle.indexOf("await releaseScheduleFire(")
    const finalize = lifecycle.indexOf("await finalizeScheduleFire(")

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(release).toBeGreaterThan(-1)
    expect(finalize).toBeGreaterThan(release)
    expect(lifecycle.slice(0, finalize)).not.toContain(
      "await completeScheduleFire(",
    )
    expect(lifecycle).toContain("let fireExecutionStarted = false")
    expect(lifecycle).toContain("fireExecutionStarted = true")
    expect(lifecycle).toContain("fireClaim && !fireExecutionStarted")
  })

  it("advances a recoverable fire claim immediately before job execution", () => {
    const start = source.indexOf("async function runLockedScheduleTurn(")
    const end = source.indexOf("async function finalizeScheduleFire(", start)
    const lifecycle = source.slice(start, end)

    expect(lifecycle.indexOf("runWithJobLock(")).toBeLessThan(
      lifecycle.indexOf("await beginScheduleFireExecution("),
    )
    expect(lifecycle.indexOf("await beginScheduleFireExecution(")).toBeLessThan(
      lifecycle.indexOf("executeLockedScheduledTurn("),
    )
  })
})
