import {
  JOB_LOCK_LEASE_SECONDS,
  JOB_LOCK_RENEW_INTERVAL_MS,
  releaseJobLock,
  renewJobLock,
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
    const nowSeconds = Math.floor(Date.now() / 1000)

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
    expect(
      put.mock.calls[0][0].Item.expiresAt - nowSeconds,
    ).toBeGreaterThanOrEqual(JOB_LOCK_LEASE_SECONDS)
  })

  it("correlates a session lock with the immutable schedule fire", async () => {
    const put = jest.fn().mockResolvedValue({})
    const fireKey = "schedule-fire#schedule-id#2026-07-28T15:00:00Z"

    await expect(
      tryAcquireJobLock(
        SESSION_ID,
        TABLE,
        { put, delete: jest.fn() },
        logger(),
        fireKey,
      ),
    ).resolves.toMatchObject({ acquired: true })

    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        Item: expect.objectContaining({ fireKey }),
      }),
    )
  })

  it("reports the immutable fire that owns a contended session lock", async () => {
    const contention = Object.assign(new Error("already held"), {
      name: "ConditionalCheckFailedException",
    })
    const fireKey = "schedule-fire#schedule-id#2026-07-28T15:00:00Z"
    const put = jest.fn().mockRejectedValue(contention)
    const get = jest.fn().mockResolvedValue({
      Item: { fireKey },
    })

    await expect(
      tryAcquireJobLock(
        SESSION_ID,
        TABLE,
        { put, get, delete: jest.fn() },
        logger(),
        fireKey,
      ),
    ).resolves.toEqual({
      acquired: false,
      phase: "lock-contention",
      severity: "warn",
      errorMessage:
        "Session lock contended; another invocation owns this schedule session",
      ownerFireKey: fireKey,
    })
    expect(get).toHaveBeenCalledWith({
      TableName: TABLE,
      Key: { sessionId: SESSION_ID },
      ConsistentRead: true,
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
        { put, delete: deleteItem, update: jest.fn() },
        logger(),
        { execute },
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
        { put, delete: jest.fn(), update: jest.fn() },
        logger(),
        { execute },
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
})

describe("agent-cron same-fire lock recovery", () => {
  it("reclaims a stale session lock correlated to the same owned fire", async () => {
    const contention = Object.assign(new Error("already held"), {
      name: "ConditionalCheckFailedException",
    })
    const fireKey = "schedule-fire#schedule-id#2026-07-28T15:00:00Z"
    const put = jest.fn()
      .mockRejectedValueOnce(contention)
      .mockResolvedValueOnce({})
    const get = jest.fn().mockResolvedValue({ Item: { fireKey } })
    const deleteItem = jest.fn().mockResolvedValue({})
    const execute = jest.fn().mockResolvedValue({
      value: "delivered",
      retainLock: false,
    })

    await expect(
      runWithJobLock(
        SESSION_ID,
        TABLE,
        { put, get, delete: deleteItem, update: jest.fn() },
        logger(),
        { execute, fireKey },
      ),
    ).resolves.toEqual({ executed: true, value: "delivered" })

    expect(deleteItem.mock.calls[0][0]).toMatchObject({
      Key: { sessionId: SESSION_ID },
      ConditionExpression: "fireKey = :fireKey",
      ExpressionAttributeValues: { ":fireKey": fireKey },
    })
    expect(put).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe("agent-cron session-lock lifecycle", () => {
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

  it("renews the transferred lock before launching the background runner", async () => {
    const update = jest.fn().mockResolvedValue({})
    const nowSeconds = Math.floor(Date.now() / 1000)

    await expect(
      renewJobLock(
        SESSION_ID,
        "owned-token",
        TABLE,
        { update },
        logger(),
      ),
    ).resolves.toEqual({ acquired: true, lockToken: "owned-token" })

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: TABLE,
        Key: { sessionId: SESSION_ID },
        UpdateExpression: "SET expiresAt = :expiresAt",
        ConditionExpression: "lockToken = :token",
        ExpressionAttributeValues: expect.objectContaining({
          ":token": "owned-token",
        }),
      }),
    )
    expect(
      update.mock.calls[0][0].ExpressionAttributeValues[":expiresAt"]
        - nowSeconds,
    ).toBeGreaterThanOrEqual(JOB_LOCK_LEASE_SECONDS)
  })

  it("releases the pre-invocation lock after a normal scheduled turn", async () => {
    const put = jest.fn().mockResolvedValue({})
    const deleteItem = jest.fn().mockResolvedValue({})
    const update = jest.fn().mockResolvedValue({})
    const execute = jest.fn().mockResolvedValue({
      value: "delivered",
      retainLock: false,
    })

    await expect(
      runWithJobLock(
        SESSION_ID,
        TABLE,
        { put, delete: deleteItem, update },
        logger(),
        { execute },
      ),
    ).resolves.toEqual({ executed: true, value: "delivered" })

    expect(execute).toHaveBeenCalledWith(expect.any(String))
    expect(deleteItem).toHaveBeenCalledTimes(1)
  })

  it("transfers the pre-invocation lock to a promoted background job", async () => {
    const put = jest.fn().mockResolvedValue({})
    const deleteItem = jest.fn().mockResolvedValue({})
    const update = jest.fn().mockResolvedValue({})
    const execute = jest.fn().mockResolvedValue({
      value: "promoted",
      retainLock: true,
    })

    await expect(
      runWithJobLock(
        SESSION_ID,
        TABLE,
        { put, delete: deleteItem, update },
        logger(),
        { execute },
      ),
    ).resolves.toEqual({ executed: true, value: "promoted" })

    expect(execute).toHaveBeenCalledWith(expect.any(String))
    expect(deleteItem).not.toHaveBeenCalled()
  })

  it("retains the lease when scheduled execution throws before an explicit outcome", async () => {
    const put = jest.fn().mockResolvedValue({})
    const update = jest.fn().mockResolvedValue({})
    const deleteItem = jest.fn().mockResolvedValue({})

    await expect(
      runWithJobLock(
        SESSION_ID,
        TABLE,
        { put, delete: deleteItem, update },
        logger(),
        {
          execute: async () => {
            throw new Error("delivery disconnected")
          },
        },
      ),
    ).rejects.toThrow("delivery disconnected")

    expect(deleteItem).not.toHaveBeenCalled()
  })

  it("renews a synchronous scheduled turn every five minutes", async () => {
    const put = jest.fn().mockResolvedValue({})
    const update = jest.fn().mockResolvedValue({})
    const deleteItem = jest.fn().mockResolvedValue({})
    const intervals: number[] = []
    const stoppedTimers: unknown[] = []

    await expect(
      runWithJobLock(
        SESSION_ID,
        TABLE,
        { put, delete: deleteItem, update },
        logger(),
        {
          execute: async () => ({
            value: "delivered",
            retainLock: false,
          }),
          renewalScheduler: {
            start: (callback, intervalMs) => {
              intervals.push(intervalMs)
              callback()
              return "renewal-timer"
            },
            stop: timer => {
              stoppedTimers.push(timer)
            },
          },
        },
      ),
    ).resolves.toEqual({ executed: true, value: "delivered" })

    expect(intervals).toEqual([JOB_LOCK_RENEW_INTERVAL_MS])
    expect(update).toHaveBeenCalledTimes(1)
    expect(stoppedTimers).toEqual(["renewal-timer"])
    expect(deleteItem).toHaveBeenCalledTimes(1)
  })
})
