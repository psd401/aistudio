import {
  releaseJobLock,
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

  it("reports lock contention without launching a second job", async () => {
    const contention = Object.assign(new Error("already held"), {
      name: "ConditionalCheckFailedException",
    })
    const put = jest.fn().mockRejectedValue(contention)
    const deleteItem = jest.fn().mockResolvedValue({})

    await expect(
      tryAcquireJobLock(
        SESSION_ID,
        TABLE,
        { put, delete: deleteItem },
        logger(),
      ),
    ).resolves.toEqual({
      acquired: false,
      phase: "lock-contention",
      severity: "warn",
      errorMessage:
        "Session lock contended; another invocation owns this schedule session",
    })
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
})
