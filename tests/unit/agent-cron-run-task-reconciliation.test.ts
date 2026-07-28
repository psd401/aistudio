import {
  reconcileRunTaskLaunch,
  type RunTaskReconciliationDependencies,
} from "../../infra/lambdas/agent-cron/run-task-reconciliation"

function harness(
  overrides: Partial<RunTaskReconciliationDependencies> = {},
) {
  const runTask = jest.fn().mockResolvedValue({
    taskArns: ["arn:aws:ecs:us-east-1:123:task/accepted"],
    failures: [],
  })
  const listTasks = jest.fn().mockResolvedValue([])
  const wait = jest.fn().mockResolvedValue(undefined)
  return {
    dependencies: {
      runTask,
      listTasks,
      wait,
      ...overrides,
    } satisfies RunTaskReconciliationDependencies,
    runTask,
    listTasks,
    wait,
  }
}

describe("agent-cron RunTask reconciliation", () => {
  it("accepts the initial task ARN without reconciliation", async () => {
    const { dependencies, runTask, listTasks } = harness()

    await expect(reconcileRunTaskLaunch(dependencies)).resolves.toEqual({
      status: "accepted",
      taskArn: "arn:aws:ecs:us-east-1:123:task/accepted",
      reconciled: false,
    })
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(listTasks).not.toHaveBeenCalled()
  })

  it("retries the identical launch after a lost response", async () => {
    const { dependencies, runTask, listTasks } = harness()
    runTask
      .mockRejectedValueOnce(new Error("socket timed out"))
      .mockResolvedValueOnce({
        taskArns: ["arn:aws:ecs:us-east-1:123:task/retried"],
        failures: [],
      })

    await expect(reconcileRunTaskLaunch(dependencies)).resolves.toEqual({
      status: "accepted",
      taskArn: "arn:aws:ecs:us-east-1:123:task/retried",
      reconciled: true,
    })
    expect(runTask).toHaveBeenCalledTimes(2)
    expect(listTasks).not.toHaveBeenCalled()
  })

  it("finds an accepted task after both launch responses are lost", async () => {
    const { dependencies, runTask, listTasks } = harness()
    runTask.mockRejectedValue(new Error("response lost"))
    listTasks.mockResolvedValueOnce([
      "arn:aws:ecs:us-east-1:123:task/reconciled",
    ])

    await expect(reconcileRunTaskLaunch(dependencies)).resolves.toEqual({
      status: "accepted",
      taskArn: "arn:aws:ecs:us-east-1:123:task/reconciled",
      reconciled: true,
    })
    expect(runTask).toHaveBeenCalledTimes(2)
    expect(listTasks).toHaveBeenCalledWith("RUNNING")
  })

  it("rejects only after the final running/stopped lookup is empty", async () => {
    const { dependencies, runTask, listTasks, wait } = harness()
    runTask.mockRejectedValue(new Error("endpoint unavailable"))

    await expect(reconcileRunTaskLaunch(dependencies)).resolves.toEqual({
      status: "rejected",
      errorMessage:
        "RunTask failed after an idempotent retry and no task was found",
    })
    expect(listTasks).toHaveBeenCalledTimes(10)
    expect(listTasks).toHaveBeenLastCalledWith("STOPPED")
    expect(wait).toHaveBeenCalledTimes(4)
  })

  it("does not call an unreconciled launch a rejection", async () => {
    const { dependencies, runTask, listTasks } = harness()
    runTask.mockRejectedValue(new Error("endpoint unavailable"))
    listTasks.mockRejectedValue(new Error("ListTasks unavailable"))

    await expect(reconcileRunTaskLaunch(dependencies)).resolves.toEqual({
      status: "ambiguous",
      errorMessage:
        "RunTask outcome remained ambiguous: ListTasks unavailable",
    })
  })

  it("treats explicit ECS failures as definitive rejections", async () => {
    const { dependencies, listTasks } = harness({
      runTask: jest.fn().mockResolvedValue({
        taskArns: [],
        failures: [{ reason: "RESOURCE:CPU", detail: "insufficient" }],
      }),
    })

    await expect(reconcileRunTaskLaunch(dependencies)).resolves.toEqual({
      status: "rejected",
      errorMessage:
        "RunTask failures: RESOURCE:CPU (insufficient)",
    })
    expect(listTasks).not.toHaveBeenCalled()
  })
})
