import {
  createPromotedRun,
  createRunTelemetry,
  updatePromotedRunTerminal,
  type CronTelemetryLogger,
} from "../../infra/lambdas/agent-cron/run-telemetry"

const config = {
  databaseResourceArn: "arn:aws:rds:us-east-1:123:cluster:test",
  databaseSecretArn: "arn:aws:secretsmanager:us-east-1:123:secret:test",
  databaseName: "aistudio",
}

function harness(overrides: Partial<typeof config> = {}) {
  const execute = jest.fn().mockResolvedValue({})
  const warn = jest.fn()
  const error = jest.fn()
  const telemetry = createRunTelemetry(
    { ...config, ...overrides },
    { execute },
  )
  const log = { warn, error } satisfies CronTelemetryLogger
  return { telemetry, execute, warn, error, log }
}

describe("agent-cron run telemetry", () => {
  it("creates a promoted row and returns its per-fire primary key", async () => {
    const execute = jest.fn().mockResolvedValue({
      records: [[{ stringValue: "901" }]],
    })

    await expect(
      createPromotedRun(
        config,
        { execute },
        {
          userEmail: "owner@psd401.net",
          scheduleId: "schedule-id",
          scheduleName: "Morning brief",
          sessionId: "shared-daily-session",
          inputTokens: 1,
          outputTokens: 2,
          latencyMs: 3,
          status: "promoted",
        },
      ),
    ).resolves.toBe("901")

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("RETURNING CAST(id AS TEXT)"),
      }),
    )
  })

  it("keys the STOPPED terminal repair by the promoted row ID", async () => {
    const execute = jest.fn().mockResolvedValue({ numberOfRecordsUpdated: 1 })

    await expect(
      updatePromotedRunTerminal(
        config,
        { execute },
        {
          scheduledRunId: "902",
          userEmail: "owner@psd401.net",
          scheduleId: "schedule-id",
          scheduleName: "Morning brief",
          sessionId: "shared-daily-session",
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 10_000,
          status: "success",
        },
      ),
    ).resolves.toBe(true)

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringMatching(
          /WHERE id = CAST\(:scheduled_run_id AS bigint\)[\s\S]+status = 'promoted'/,
        ),
        parameters: expect.arrayContaining([
          {
            name: "scheduled_run_id",
            value: { stringValue: "902" },
          },
        ]),
      }),
    )
  })

  it("verifies an exact terminal row when the supervisor update is a no-op", async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ numberOfRecordsUpdated: 0 })
      .mockResolvedValueOnce({
        records: [[{ stringValue: "success" }]],
      })

    await expect(
      updatePromotedRunTerminal(
        config,
        { execute },
        {
          scheduledRunId: "902",
          userEmail: "owner@psd401.net",
          scheduleId: "schedule-id",
          sessionId: "shared-daily-session",
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 10_000,
          status: "success",
        },
      ),
    ).resolves.toBe(false)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it("rejects a missing per-fire row instead of acknowledging false durability", async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ numberOfRecordsUpdated: 0 })
      .mockResolvedValueOnce({ records: [] })

    await expect(
      updatePromotedRunTerminal(
        config,
        { execute },
        {
          scheduledRunId: "902",
          userEmail: "owner@psd401.net",
          scheduleId: "schedule-id",
          sessionId: "shared-daily-session",
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 10_000,
          status: "error",
        },
      ),
    ).rejects.toThrow("has no terminal state")
  })
})

describe("agent-cron ordinary run telemetry", () => {
  it("records a rejected reference as a skipped scheduled run", async () => {
    const { telemetry, execute, log } = harness()

    await telemetry.recordRun(
      {
        userEmail: "owner@psd401.net",
        scheduleId: "schedule-id",
        sessionId: "reference-session",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 12,
        status: "skipped",
        errorMessage: "Schedule reference rejected: version-mismatch",
      },
      log,
    )

    expect(execute).toHaveBeenCalledTimes(1)
    const input = execute.mock.calls[0][0]
    expect(input.sql).toContain(
      "INSERT INTO agent_scheduled_runs",
    )
    expect(input.parameters).toEqual(
      expect.arrayContaining([
        { name: "status", value: { stringValue: "skipped" } },
        {
          name: "error_message",
          value: {
            stringValue: "Schedule reference rejected: version-mismatch",
          },
        },
      ]),
    )
  })

  it("mirrors a contended pre-invocation lock with its phase", async () => {
    const { telemetry, execute, error, log } = harness()

    await telemetry.recordRun(
      {
        userEmail: "owner@psd401.net",
        scheduleId: "schedule-id",
        scheduleName: "Morning brief",
        sessionId: "schedule-session",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 3,
        status: "skipped",
        errorMessage: "Session lock contended",
        failure: {
          severity: "warn",
          context: { phase: "lock-contention" },
        },
      },
      log,
    )

    expect(execute).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith(
      "AGENT_FAILURE_RECORD",
      expect.objectContaining({
        userId: "o***@psd401.net",
      }),
    )
    expect(execute.mock.calls[1][0].parameters).toEqual(
      expect.arrayContaining([
        { name: "severity", value: { stringValue: "warn" } },
        {
          name: "user_id",
          value: { stringValue: "owner@psd401.net" },
        },
        {
          name: "context",
          value: {
            stringValue: JSON.stringify({
              scheduleId: "schedule-id",
              phase: "lock-contention",
            }),
          },
        },
      ]),
    )
  })
})

describe("agent-cron failure telemetry", () => {
  it("mirrors a lookup error into the cron failure stream", async () => {
    const { telemetry, execute, error, log } = harness()

    await telemetry.recordRun(
      {
        userEmail: "owner@psd401.net",
        scheduleId: "schedule-id",
        sessionId: "reference-session",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 20,
        status: "error",
        errorMessage: "Authoritative schedule lookup failed: unavailable",
      },
      log,
    )

    expect(execute).toHaveBeenCalledTimes(2)
    const failureInput = execute.mock.calls[1][0]
    expect(failureInput.sql).toContain("INSERT INTO agent_failures")
    expect(failureInput.parameters).toEqual(
      expect.arrayContaining([
        { name: "severity", value: { stringValue: "error" } },
        {
          name: "context",
          value: {
            stringValue: JSON.stringify({
              scheduleId: "schedule-id",
              phase: "scheduled-run",
            }),
          },
        },
      ]),
    )
    expect(error).toHaveBeenCalledWith(
      "AGENT_FAILURE_RECORD",
      expect.objectContaining({
        source: "cron",
        scheduleId: "schedule-id",
      }),
    )
  })

  it("records promotion abort phase and severity", async () => {
    const { telemetry, execute, log } = harness()

    await telemetry.recordCronFailure(
      {
        userEmail: "owner@psd401.net",
        scheduleId: "schedule-id",
        scheduleName: "Morning brief",
        sessionId: "session-id",
        errorMessage: "RunTask failed",
        severity: "error",
        context: {
          phase: "run-task",
          promotionReason: "deadline",
        },
      },
      log,
    )

    const failureInput = execute.mock.calls[0][0]
    expect(failureInput.parameters).toEqual(
      expect.arrayContaining([
        { name: "severity", value: { stringValue: "error" } },
        {
          name: "context",
          value: {
            stringValue: JSON.stringify({
              scheduleId: "schedule-id",
              phase: "run-task",
              promotionReason: "deadline",
            }),
          },
        },
      ]),
    )
  })

  it("still emits the failure marker when database telemetry is unavailable", async () => {
    const { telemetry, execute, error, log } = harness({
      databaseResourceArn: "",
      databaseSecretArn: "",
    })

    await telemetry.recordRun(
      {
        userEmail: "owner@psd401.net",
        scheduleId: "schedule-id",
        sessionId: "reference-session",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 1,
        status: "error",
        errorMessage: "lookup failed",
      },
      log,
    )

    expect(execute).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      "AGENT_FAILURE_RECORD",
      expect.objectContaining({ source: "cron" }),
    )
  })
})
