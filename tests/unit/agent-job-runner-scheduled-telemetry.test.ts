import fs from "node:fs"
import path from "node:path"
import {
  recordScheduledJobTerminal,
  type ScheduledJobContext,
} from "../../infra/lambdas/agent-router/scheduled-run-telemetry"
import {
  sanitizeEmailForLog,
} from "../../infra/lambdas/agent-router/log-sanitization"

const routerSource = fs.readFileSync(
  path.join(process.cwd(), "infra/lambdas/agent-router/index.ts"),
  "utf8",
)

const scheduledJob = {
  scheduledRunId: "901",
  fireKey:
    "schedule-fire#36bb0456-1c51-4fb8-97d1-4e87d02765ce#" +
    "2026-07-28T15:00:00.000Z",
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

  it("records the schedule transcript instead of runtime affinity", async () => {
    const writer = jest.fn().mockResolvedValue(undefined)
    const conversationSessionId =
      "workspace-sched-36bb0456-2026-07-28"

    await recordScheduledJobTerminal(
      {
        ...scheduledJob,
        sessionId:
          "agent-runtime-b08ac1084c116c38a63301096938e92e-build",
        conversationSessionId,
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

    expect(writer).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: conversationSessionId }),
    )
  })

  it("persists the terminal result by promoted primary key", () => {
    expect(routerSource).toContain(
      "WHERE id = CAST(${params.scheduledRunId} AS bigint)",
    )
    expect(routerSource).toContain("AND status = 'promoted'")
    expect(routerSource).toContain(
      "input_tokens = input_tokens + ${params.inputTokens}",
    )
    expect(routerSource).toContain(
      "sanitizeDiagnostic(params.errorMessage, 4000)",
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

  it("sanitizes a scheduled failure before the terminal writer", async () => {
    const writer = jest.fn().mockResolvedValue(undefined)

    await recordScheduledJobTerminal(
      scheduledJob,
      {
        status: "error",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 789,
        errorMessage:
          "Failed for student@psd401.net Authorization: Bearer abc.def " +
          "token=top-secret https://auth.example.test/callback?code=secret",
      },
      writer,
      logger(),
    )

    const errorMessage = writer.mock.calls[0][0].errorMessage
    expect(errorMessage).toContain("[REDACTED_EMAIL]")
    expect(errorMessage).toContain("[REDACTED_URL]")
    expect(errorMessage).not.toContain("student@psd401.net")
    expect(errorMessage).not.toContain("abc.def")
    expect(errorMessage).not.toContain("top-secret")
  })

  it("masks owner identity in router CloudWatch fields", () => {
    expect(sanitizeEmailForLog("owner@psd401.net")).toBe("o***@psd401.net")
    expect(routerSource).toContain(
      "userId: params.userId ? sanitizeEmailForLog(params.userId) : null",
    )
    const jobSource = fs.readFileSync(
      path.join(process.cwd(), "infra/lambdas/agent-router/job-main.ts"),
      "utf8",
    )
    expect(jobSource).toContain(
      "userEmail: sanitizeEmailForLog(job.userEmail)",
    )
  })
})
