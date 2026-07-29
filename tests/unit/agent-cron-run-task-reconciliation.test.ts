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
  const listRunningTasks = jest.fn().mockResolvedValue([])
  const listStoppedTasks = jest.fn().mockResolvedValue({ taskArns: [] })
  const describeTasks = jest.fn().mockResolvedValue([])
  const wait = jest.fn().mockResolvedValue(undefined)
  return {
    dependencies: {
      startedBy: "scheduled-run-123",
      runTask,
      listRunningTasks,
      listStoppedTasks,
      describeTasks,
      wait,
      ...overrides,
    } satisfies RunTaskReconciliationDependencies,
    runTask,
    listRunningTasks,
    listStoppedTasks,
    describeTasks,
    wait,
  }
}

function awsError(
  name: string,
  message: string,
  httpStatusCode: number,
  extras: Record<string, unknown> = {},
): Error {
  return Object.assign(new Error(message), {
    name,
    $metadata: {
      httpStatusCode,
      requestId: `request-${name}`,
      attempts: 3,
      totalRetryDelay: 125,
    },
    ...extras,
  })
}

describe("agent-cron RunTask response classification", () => {
  it("accepts the initial task ARN without reconciliation", async () => {
    const { dependencies, runTask, listRunningTasks } = harness()

    await expect(reconcileRunTaskLaunch(dependencies)).resolves.toEqual({
      status: "accepted",
      taskArn: "arn:aws:ecs:us-east-1:123:task/accepted",
      reconciled: false,
    })
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(listRunningTasks).not.toHaveBeenCalled()
  })

  it("retries the identical launch after a lost response", async () => {
    const { dependencies, runTask, listRunningTasks } = harness()
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
    expect(listRunningTasks).not.toHaveBeenCalled()
  })

  it("rejects a definitive first-attempt ECS exception without retrying", async () => {
    const { dependencies, runTask, listRunningTasks } = harness()
    runTask.mockRejectedValue(
      awsError("AccessDeniedException", "role denied", 400),
    )

    await expect(reconcileRunTaskLaunch(dependencies)).resolves.toEqual({
      status: "rejected",
      errorMessage:
        "RunTask request rejected: AccessDeniedException " +
        "[HTTP 400, request request-AccessDeniedException, SDK attempts 3, " +
        "SDK retry delay 125ms]: role denied",
    })
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(listRunningTasks).not.toHaveBeenCalled()
  })

  it("redacts secrets, bearer tokens, and email addresses from diagnostics", async () => {
    const { dependencies, runTask } = harness()
    runTask.mockRejectedValue(
      awsError(
        "InvalidParameterException",
        "token=top-secret Bearer abc.def owner@example.com",
        400,
      ),
    )

    const result = await reconcileRunTaskLaunch(dependencies)

    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining(
        "token=[REDACTED] Bearer [REDACTED] [REDACTED_EMAIL]",
      ),
    }))
    expect(result).not.toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("top-secret"),
    }))
    expect(result).not.toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("owner@example.com"),
    }))
  })

  it("preserves the initial transport error when the retry is definitive", async () => {
    const { dependencies, runTask, listRunningTasks } = harness()
    runTask
      .mockRejectedValueOnce(new Error("first response lost"))
      .mockRejectedValueOnce(
        awsError("InvalidParameterException", "bad subnet", 400),
      )

    const result = await reconcileRunTaskLaunch(dependencies)

    expect(result.status).toBe("rejected")
    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("first response lost"),
    }))
    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("InvalidParameterException [HTTP 400"),
    }))
    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("bad subnet"),
    }))
    expect(listRunningTasks).not.toHaveBeenCalled()
  })

  it("does not adopt resource IDs from a mismatched-token conflict", async () => {
    const { dependencies, runTask, listRunningTasks } = harness()
    runTask.mockRejectedValue(
      awsError("ConflictException", "client token parameters differ", 400, {
        resourceIds: ["arn:aws:ecs:us-east-1:123:task/unrelated"],
      }),
    )

    const result = await reconcileRunTaskLaunch(dependencies)

    expect(result).toEqual(expect.objectContaining({
      status: "rejected",
      errorMessage: expect.stringContaining("ConflictException"),
    }))
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(listRunningTasks).not.toHaveBeenCalled()
  })

})

describe("agent-cron ambiguous RunTask lookup", () => {
  it("finds an accepted running task after both responses are uncertain", async () => {
    const { dependencies, runTask, listRunningTasks } = harness()
    runTask
      .mockRejectedValueOnce(awsError("ServerException", "first 500", 500))
      .mockRejectedValueOnce(new Error("retry response lost"))
    listRunningTasks.mockResolvedValueOnce([
      "arn:aws:ecs:us-east-1:123:task/reconciled",
    ])

    await expect(reconcileRunTaskLaunch(dependencies)).resolves.toEqual({
      status: "accepted",
      taskArn: "arn:aws:ecs:us-east-1:123:task/reconciled",
      reconciled: true,
    })
    expect(runTask).toHaveBeenCalledTimes(2)
    expect(listRunningTasks).toHaveBeenCalledTimes(1)
  })

  it("paginates stopped tasks and filters their exact startedBy", async () => {
    const {
      dependencies,
      runTask,
      listStoppedTasks,
      describeTasks,
    } = harness()
    runTask.mockRejectedValue(new Error("response lost"))
    listStoppedTasks
      .mockResolvedValueOnce({
        taskArns: ["arn:aws:ecs:us-east-1:123:task/unrelated"],
        nextToken: "page-2",
      })
      .mockResolvedValueOnce({
        taskArns: ["arn:aws:ecs:us-east-1:123:task/stopped"],
      })
    describeTasks
      .mockResolvedValueOnce([
        {
          taskArn: "arn:aws:ecs:us-east-1:123:task/unrelated",
          startedBy: "someone-else",
        },
      ])
      .mockResolvedValueOnce([
        {
          taskArn: "arn:aws:ecs:us-east-1:123:task/stopped",
          startedBy: "scheduled-run-123",
        },
      ])

    await expect(reconcileRunTaskLaunch(dependencies)).resolves.toEqual({
      status: "accepted",
      taskArn: "arn:aws:ecs:us-east-1:123:task/stopped",
      reconciled: true,
    })
    expect(listStoppedTasks).toHaveBeenNthCalledWith(1, undefined)
    expect(listStoppedTasks).toHaveBeenNthCalledWith(2, "page-2")
    expect(describeTasks).toHaveBeenCalledTimes(2)
  })

  it("keeps successful empty eventually consistent lookups ambiguous", async () => {
    const {
      dependencies,
      runTask,
      listRunningTasks,
      listStoppedTasks,
      wait,
    } = harness()
    runTask
      .mockRejectedValueOnce(new Error("first response lost"))
      .mockRejectedValueOnce(awsError("ServerException", "second 500", 500))

    const result = await reconcileRunTaskLaunch(dependencies)

    expect(result.status).toBe("ambiguous")
    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("Attempt 1: Error: first response lost"),
    }))
    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("Attempt 2: ServerException [HTTP 500"),
    }))
    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("second 500"),
    }))
    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining(
        "empty eventually consistent lookup is not proof of rejection",
      ),
    }))
    expect(listRunningTasks).toHaveBeenCalledTimes(5)
    expect(listStoppedTasks).toHaveBeenCalledTimes(5)
    expect(wait).toHaveBeenCalledTimes(4)
  })

  it("preserves both launch failures and the final lookup failure", async () => {
    const { dependencies, runTask, listRunningTasks } = harness()
    runTask
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockRejectedValueOnce(awsError("ServerException", "ECS unavailable", 500))
    listRunningTasks.mockRejectedValue(
      awsError("AccessDeniedException", "ListTasks denied", 400),
    )

    const result = await reconcileRunTaskLaunch(dependencies)

    expect(result.status).toBe("ambiguous")
    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("socket reset"),
    }))
    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("ServerException [HTTP 500"),
    }))
    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("ECS unavailable"),
    }))
    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("AccessDeniedException [HTTP 400"),
    }))
    expect(result).toEqual(expect.objectContaining({
      errorMessage: expect.stringContaining("ListTasks denied"),
    }))
  })

  it("treats explicit ECS response failures as definitive rejections", async () => {
    const { dependencies, listRunningTasks } = harness({
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
    expect(listRunningTasks).not.toHaveBeenCalled()
  })

  it("accepts a task ARN even when ECS also returns failure diagnostics", async () => {
    const { dependencies } = harness({
      runTask: jest.fn().mockResolvedValue({
        taskArns: ["arn:aws:ecs:us-east-1:123:task/placed"],
        failures: [{ reason: "RESOURCE:CPU", detail: "another placement failed" }],
      }),
    })

    await expect(reconcileRunTaskLaunch(dependencies)).resolves.toEqual({
      status: "accepted",
      taskArn: "arn:aws:ecs:us-east-1:123:task/placed",
      reconciled: false,
    })
  })
})
