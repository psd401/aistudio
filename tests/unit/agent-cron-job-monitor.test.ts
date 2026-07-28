import {
  isJobRunnerStoppedEvent,
  monitorStoppedJob,
  type JobMonitorDependencies,
  type JobRunnerStoppedEvent,
  type JobTaskSnapshot,
} from "../../infra/lambdas/agent-cron/job-monitor"

const taskArn =
  "arn:aws:ecs:us-east-1:123456789012:task/cluster/task-id"
const event = {
  source: "aws.ecs",
  "detail-type": "ECS Task State Change",
  time: "2026-07-28T16:30:10.000Z",
  detail: {
    clusterArn:
      "arn:aws:ecs:us-east-1:123456789012:cluster/agent-jobs",
    taskArn,
    lastStatus: "STOPPED",
    stopCode: "EssentialContainerExited",
    stoppedReason: "Essential container in task exited",
  },
} satisfies JobRunnerStoppedEvent

const scheduledPayloadValue = {
  scheduledRunId: "901",
  scheduleId: "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
  scheduleName: "Morning brief",
  userEmail: "owner@psd401.net",
  sessionId: "workspace-sched-36bb0456-2026-07-28",
}
const scheduledPayload = JSON.stringify(scheduledPayloadValue)

function snapshot(
  exitCode: number | undefined,
  payload = scheduledPayload,
): JobTaskSnapshot {
  return {
    taskArn,
    createdAt: new Date("2026-07-28T16:30:00.000Z"),
    stoppedAt: new Date("2026-07-28T16:30:10.000Z"),
    stopCode: exitCode === undefined
      ? "TaskFailedToStart"
      : "EssentialContainerExited",
    stoppedReason: exitCode === undefined
      ? "CannotPullContainerError"
      : "Essential container in task exited",
    containers: [
      {
        name: "job-runner",
        ...(exitCode === undefined ? {} : { exitCode }),
      },
    ],
    overrides: {
      containerOverrides: [
        {
          name: "job-runner",
          environment: [{ name: "JOB_PAYLOAD", value: payload }],
        },
      ],
    },
  }
}

function harness(task: JobTaskSnapshot) {
  const writeRun = jest.fn().mockResolvedValue(true)
  const recordFailure = jest.fn().mockResolvedValue(undefined)
  const dependencies = {
    describeTask: jest.fn().mockResolvedValue(task),
    writeRun,
    recordFailure,
  } satisfies JobMonitorDependencies
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  return { dependencies, writeRun, recordFailure, log }
}

describe("agent job STOPPED-state monitor", () => {
  it("confirms authoritative success after a clean scheduled job exit", async () => {
    const { dependencies, writeRun, recordFailure, log } = harness(snapshot(0))

    await expect(
      monitorStoppedJob(event, "job-runner", dependencies, log),
    ).resolves.toEqual({
      status: "success",
      scheduleId: "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
    })

    expect(writeRun).toHaveBeenCalledWith({
      scheduledRunId: "901",
      userEmail: "owner@psd401.net",
      scheduleId: "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
      scheduleName: "Morning brief",
      sessionId: "workspace-sched-36bb0456-2026-07-28",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 10_000,
      status: "success",
    })
    expect(recordFailure).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      "Scheduled background job terminal state confirmed",
      expect.objectContaining({ owner: "o***@psd401.net" }),
    )
  })

  it("turns a task that never started into a durable terminal error", async () => {
    const { dependencies, writeRun, recordFailure, log } = harness(
      snapshot(undefined),
    )

    await expect(
      monitorStoppedJob(event, "job-runner", dependencies, log),
    ).resolves.toEqual({
      status: "error",
      scheduleId: "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
    })

    expect(writeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        errorMessage: expect.stringContaining("TaskFailedToStart"),
      }),
    )
    expect(recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          phase: "job-supervisor",
          taskArn,
        }),
      }),
    )
    expect(log.error).toHaveBeenCalledWith(
      "Scheduled background job stopped unsuccessfully",
      expect.objectContaining({ owner: "o***@psd401.net" }),
    )
  })

  it("ignores interactive background jobs without a schedule ID", async () => {
    const interactive = JSON.stringify({
      userEmail: "owner@psd401.net",
      sessionId: "interactive-session",
    })
    const { dependencies, writeRun, recordFailure, log } = harness(
      snapshot(0, interactive),
    )

    await expect(
      monitorStoppedJob(event, "job-runner", dependencies, log),
    ).resolves.toEqual({
      status: "skipped",
      scheduleId: "interactive",
    })
    expect(writeRun).not.toHaveBeenCalled()
    expect(recordFailure).not.toHaveBeenCalled()
  })

  it("propagates the terminal write failure to the async retry path", async () => {
    const { dependencies, log } = harness(snapshot(0))
    dependencies.writeRun.mockRejectedValueOnce(new Error("Aurora unavailable"))

    await expect(
      monitorStoppedJob(event, "job-runner", dependencies, log),
    ).rejects.toThrow("Aurora unavailable")
  })

  it("does not duplicate the failure mirror when the runner recorded terminal state", async () => {
    const { dependencies, recordFailure, log } = harness(snapshot(2))
    dependencies.writeRun.mockResolvedValueOnce(false)

    await expect(
      monitorStoppedJob(event, "job-runner", dependencies, log),
    ).resolves.toEqual({
      status: "error",
      scheduleId: "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
    })
    expect(recordFailure).not.toHaveBeenCalled()
  })

  it("keeps two fires in the shared daily session correlated by run ID", async () => {
    const secondPayload = JSON.stringify({
      ...scheduledPayloadValue,
      scheduledRunId: "902",
    })
    const { dependencies, writeRun, log } = harness(
      snapshot(undefined, secondPayload),
    )

    await monitorStoppedJob(event, "job-runner", dependencies, log)

    expect(writeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledRunId: "902",
        sessionId: "workspace-sched-36bb0456-2026-07-28",
      }),
    )
  })

  it("recognizes only valid ECS STOPPED task events", () => {
    expect(isJobRunnerStoppedEvent(event)).toBe(true)
    expect(
      isJobRunnerStoppedEvent({
        ...event,
        detail: { ...event.detail, lastStatus: "RUNNING" },
      }),
    ).toBe(false)
    expect(isJobRunnerStoppedEvent({ source: "aws.ecs" })).toBe(false)
  })
})
