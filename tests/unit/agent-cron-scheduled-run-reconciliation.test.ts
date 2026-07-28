import {
  parseScheduledRunReconciliationMessage,
  reconcileScheduledRun,
  SCHEDULED_RUN_RECONCILIATION_DELAY_SECONDS,
} from "../../infra/lambdas/agent-cron/scheduled-run-reconciliation"

const valid = {
  type: "scheduled-run-reconciliation",
  scheduledRunId: "901",
  userEmail: "owner@psd401.net",
  scheduleId: "schedule-id",
  scheduleName: "Morning brief",
  sessionId: "scheduled-session",
  startedBy: `scheduled-${"a".repeat(26)}`,
} as const

describe("agent-cron delayed scheduled-run reconciliation", () => {
  it("uses a consistency delay longer than ECS's five-minute guidance", () => {
    expect(SCHEDULED_RUN_RECONCILIATION_DELAY_SECONDS).toBeGreaterThan(5 * 60)
  })

  it("parses the exact correlated promotion identity", () => {
    expect(
      parseScheduledRunReconciliationMessage(JSON.stringify(valid)),
    ).toEqual(valid)
  })

  it.each([
    { ...valid, type: "other" },
    { ...valid, scheduledRunId: "not-a-row" },
    { ...valid, startedBy: "scheduled-not-a-digest" },
    { ...valid, startedBy: `scheduled-${"a".repeat(64)}` },
    { ...valid, userEmail: "" },
  ])("rejects malformed resolver messages", (message) => {
    expect(() =>
      parseScheduledRunReconciliationMessage(JSON.stringify(message)),
    ).toThrow(/Invalid scheduled-run reconciliation/)
  })

  it("leaves the promoted row for an observed task and its STOPPED monitor", async () => {
    const terminalize = jest.fn()
    const recordFailure = jest.fn()

    await expect(
      reconcileScheduledRun(valid, {
        isPending: jest.fn().mockResolvedValue(true),
        findTask: jest.fn().mockResolvedValue("arn:aws:ecs:task/accepted"),
        terminalize,
        recordFailure,
      }),
    ).resolves.toEqual({
      status: "task-found",
      taskArn: "arn:aws:ecs:task/accepted",
    })
    expect(terminalize).not.toHaveBeenCalled()
    expect(recordFailure).not.toHaveBeenCalled()
  })

  it("terminalizes an unobserved launch after the durable delay", async () => {
    const terminalize = jest.fn().mockResolvedValue(true)
    const recordFailure = jest.fn().mockResolvedValue(undefined)

    const result = await reconcileScheduledRun(valid, {
      isPending: jest.fn().mockResolvedValue(true),
      findTask: jest.fn().mockResolvedValue(undefined),
      terminalize,
      recordFailure,
    })

    expect(result).toEqual({
      status: "terminalized",
      errorMessage: expect.stringContaining("remained ambiguous"),
    })
    expect(terminalize).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledRunId: valid.scheduledRunId,
        status: "error",
        errorMessage: expect.stringContaining(
          `${SCHEDULED_RUN_RECONCILIATION_DELAY_SECONDS}-second`,
        ),
      }),
    )
    expect(recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          phase: "run-task-ambiguous-terminal",
        }),
      }),
    )
  })

  it("does nothing when the reserved row was never inserted or is terminal", async () => {
    const recordFailure = jest.fn()
    const findTask = jest.fn()

    await expect(
      reconcileScheduledRun(valid, {
        isPending: jest.fn().mockResolvedValue(false),
        findTask,
        terminalize: jest.fn().mockResolvedValue(false),
        recordFailure,
      }),
    ).resolves.toEqual({ status: "no-pending-run" })
    expect(findTask).not.toHaveBeenCalled()
    expect(recordFailure).not.toHaveBeenCalled()
  })

  it("propagates lookup failure so SQS retries instead of deleting the message", async () => {
    await expect(
      reconcileScheduledRun(valid, {
        isPending: jest.fn().mockResolvedValue(true),
        findTask: jest.fn().mockRejectedValue(new Error("ECS unavailable")),
        terminalize: jest.fn(),
        recordFailure: jest.fn(),
      }),
    ).rejects.toThrow("ECS unavailable")
  })
})
