import {
  releaseJobLock,
  runWithJobLock,
  tryAcquireJobLock,
} from "../../infra/lambdas/agent-cron/job-lock"

const SESSION_ID = "owner-sched-123-2026-07-28"
const TABLE = "psd-agent-session-locks-dev"

function logger() {
  return { warn: jest.fn() }
}

describe("agent-cron per-schedule promotion lock", () => {
  it("uses one conditional lock row to reject overlapping invocations", async () => {
    const put = jest.fn().mockResolvedValue({})
    const deleteItem = jest.fn().mockResolvedValue({})

    const result = await tryAcquireJobLock(
      SESSION_ID,
      TABLE,
      { put, delete: deleteItem },
      logger(),
    )

    expect(result).toMatchObject({ acquired: true })
    expect(put.mock.calls[0][0]).toMatchObject({
      TableName: TABLE,
      Item: {
        sessionId: SESSION_ID,
        kind: "job",
      },
      ConditionExpression:
        "attribute_not_exists(sessionId) OR expiresAt < :now",
    })
  })

  it("rejects an overlapping invocation before its callback can launch a job", async () => {
    const contention = Object.assign(new Error("already held"), {
      name: "ConditionalCheckFailedException",
    })
    const put = jest.fn().mockRejectedValue(contention)
    const deleteItem = jest.fn().mockResolvedValue({})
    const execute = jest.fn()

    await expect(
      runWithJobLock(
        SESSION_ID,
        TABLE,
        { put, delete: deleteItem },
        logger(),
        execute,
      ),
    ).resolves.toEqual({
      executed: false,
      lock: {
        acquired: false,
        phase: "lock-contention",
        severity: "warn",
        errorMessage:
          "Session lock contended; another invocation owns this schedule session",
      },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(deleteItem).not.toHaveBeenCalled()
  })

  it("rejects operational lock failures so the invocation can retry", async () => {
    const put = jest.fn().mockRejectedValue(new Error("DynamoDB throttled"))
    const execute = jest.fn()

    await expect(
      runWithJobLock(
        SESSION_ID,
        TABLE,
        { put, delete: jest.fn() },
        logger(),
        execute,
      ),
    ).rejects.toMatchObject({
      name: "JobLockAcquisitionError",
      failure: {
        phase: "lock-acquire",
        severity: "error",
        errorMessage: "Session lock acquire failed: DynamoDB throttled",
      },
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it("releases only the lock token owned by the failed promotion", async () => {
    const put = jest.fn().mockResolvedValue({})
    const deleteItem = jest.fn().mockResolvedValue({})

    await releaseJobLock(
      SESSION_ID,
      "owned-token",
      TABLE,
      { put, delete: deleteItem },
      logger(),
    )

    expect(deleteItem.mock.calls[0][0]).toMatchObject({
      Key: { sessionId: SESSION_ID },
      ConditionExpression: "lockToken = :token",
      ExpressionAttributeValues: { ":token": "owned-token" },
    })
  })

  it("releases the pre-invocation lock after a normal scheduled turn", async () => {
    const put = jest.fn().mockResolvedValue({})
    const deleteItem = jest.fn().mockResolvedValue({})
    const execute = jest.fn().mockResolvedValue({
      value: "delivered",
      retainLock: false,
    })

    await expect(
      runWithJobLock(
        SESSION_ID,
        TABLE,
        { put, delete: deleteItem },
        logger(),
        execute,
      ),
    ).resolves.toEqual({ executed: true, value: "delivered" })

    expect(execute).toHaveBeenCalledWith(expect.any(String))
    expect(deleteItem).toHaveBeenCalledTimes(1)
  })

  it("transfers the pre-invocation lock to a promoted background job", async () => {
    const put = jest.fn().mockResolvedValue({})
    const deleteItem = jest.fn().mockResolvedValue({})
    const execute = jest.fn().mockResolvedValue({
      value: "promoted",
      retainLock: true,
    })

    await expect(
      runWithJobLock(
        SESSION_ID,
        TABLE,
        { put, delete: deleteItem },
        logger(),
        execute,
      ),
    ).resolves.toEqual({ executed: true, value: "promoted" })

    expect(execute).toHaveBeenCalledWith(expect.any(String))
    expect(deleteItem).not.toHaveBeenCalled()
  })
})
