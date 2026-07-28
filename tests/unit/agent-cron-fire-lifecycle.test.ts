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
  })
})
