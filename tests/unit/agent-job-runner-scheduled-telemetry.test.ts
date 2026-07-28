import fs from "node:fs"
import path from "node:path"
import {
  recordScheduledJobTerminal,
  type ScheduledJobContext,
} from "../../infra/lambdas/agent-router/scheduled-run-telemetry"

const routerSource = fs.readFileSync(
  path.join(process.cwd(), "infra/lambdas/agent-router/index.ts"),
  "utf8",
)

const scheduledJob = {
  scheduledRunId: "901",
  scheduleId: "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
  scheduleName: "Morning brief",
  userEmail: "owner@psd401.net",
  sessionId: "workspace-sched-36bb0456-2026-07-28",
} satisfies ScheduledJobContext

function logger() {
  return { error: jest.fn() }
}

describe("promoted scheduled-run terminal telemetry", () => {
  it("updates the correlated terminal result for a cron-promoted job", async () => {
    const writer = jest.fn().mockResolvedValue(undefined)

    await recordScheduledJobTerminal(
      scheduledJob,
      {
        status: "success",
        inputTokens: 12,
        outputTokens: 34,
        latencyMs: 456,
      },
      writer,
      logger(),
    )

    expect(writer).toHaveBeenCalledWith({
      ...scheduledJob,
      status: "success",
      inputTokens: 12,
      outputTokens: 34,
      latencyMs: 456,
    })
  })

  it("persists the terminal result by promoted primary key", () => {
    expect(routerSource).toContain(
      "WHERE id = CAST(${params.scheduledRunId} AS bigint)",
    )
    expect(routerSource).toContain("AND status = 'promoted'")
    expect(routerSource).toContain(
      "input_tokens = input_tokens + ${params.inputTokens}",
    )
  })

  it("does not create scheduled telemetry for an interactive job", async () => {
    const writer = jest.fn().mockResolvedValue(undefined)

    await recordScheduledJobTerminal(
      {
        userEmail: scheduledJob.userEmail,
        sessionId: scheduledJob.sessionId,
      },
      {
        status: "success",
        inputTokens: 1,
        outputTokens: 2,
        latencyMs: 3,
      },
      writer,
      logger(),
    )

    expect(writer).not.toHaveBeenCalled()
  })

  it("keeps a terminal telemetry outage from replaying delivered work", async () => {
    const writer = jest.fn().mockRejectedValue(new Error("Aurora unavailable"))
    const log = logger()

    await expect(
      recordScheduledJobTerminal(
        scheduledJob,
        {
          status: "error",
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 789,
          errorMessage: "failure ".repeat(1000),
        },
        writer,
        log,
      ),
    ).resolves.toBeUndefined()
    expect(writer.mock.calls[0][0].errorMessage).toHaveLength(4000)
    expect(log.error).toHaveBeenCalledWith(
      "Failed to record terminal scheduled job run",
      expect.objectContaining({
        scheduleId: scheduledJob.scheduleId,
        status: "error",
        error: "Aurora unavailable",
      }),
    )
  })
})
