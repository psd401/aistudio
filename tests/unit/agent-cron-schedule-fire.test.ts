import {
  claimScheduleFire,
  completeScheduleFire,
  releaseScheduleFire,
  scheduleFireIdentity,
  type ScheduleFireDynamoClient,
} from "../../infra/lambdas/agent-cron/schedule-fire"

const TABLE = "psd-agent-session-locks-dev"
const SCHEDULE_ID = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
const SCHEDULED_TIME = "2026-07-28T15:00:00Z"

function logger() {
  return { warn: jest.fn() }
}

function client(
  overrides: Partial<ScheduleFireDynamoClient> = {}
): ScheduleFireDynamoClient {
  return {
    put: jest.fn().mockResolvedValue({}),
    get: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
    ...overrides,
  }
}

const identity = {
  key: `schedule-fire#${SCHEDULE_ID}#${SCHEDULED_TIME}`,
  scheduledTime: SCHEDULED_TIME,
}

describe("agent-cron scheduled fire idempotency", () => {
  it("derives a stable fire identity from Scheduler context", () => {
    expect(
      scheduleFireIdentity({
        ownerEmail: "owner@psd401.net",
        scheduleId: SCHEDULE_ID,
        version: 1,
        scheduledTime: SCHEDULED_TIME,
      })
    ).toEqual(identity)
    expect(
      scheduleFireIdentity({
        scheduleId: SCHEDULE_ID,
        scheduledTime: "not-a-time",
      })
    ).toBeNull()
  })

  it("claims a fire with a lease that can expire after a Lambda timeout", async () => {
    const dynamo = client()

    await expect(
      claimScheduleFire(identity, TABLE, dynamo, logger())
    ).resolves.toMatchObject({
      claimed: true,
      identity,
      claimToken: expect.any(String),
    })

    expect(dynamo.put).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: TABLE,
        Item: expect.objectContaining({
          sessionId: identity.key,
          kind: "schedule-fire",
          status: "running",
        }),
        ConditionExpression:
          "attribute_not_exists(sessionId) OR expiresAt < :now",
      })
    )
  })

  it("acknowledges a completed duplicate without rerunning it", async () => {
    const contention = Object.assign(new Error("claimed"), {
      name: "ConditionalCheckFailedException",
    })
    const dynamo = client({
      put: jest.fn().mockRejectedValue(contention),
      get: jest.fn().mockResolvedValue({
        Item: { status: "completed" },
      }),
    })

    await expect(
      claimScheduleFire(identity, TABLE, dynamo, logger())
    ).resolves.toEqual({
      claimed: false,
      failure: {
        phase: "fire-completed",
        severity: "warn",
        errorMessage: "Scheduled fire was already completed",
        retryable: false,
      },
    })
  })

  it("rejects an in-progress retry instead of acknowledging stale work", async () => {
    const contention = Object.assign(new Error("claimed"), {
      name: "ConditionalCheckFailedException",
    })
    const dynamo = client({
      put: jest.fn().mockRejectedValue(contention),
      get: jest.fn().mockResolvedValue({
        Item: { status: "running" },
      }),
    })

    await expect(
      claimScheduleFire(identity, TABLE, dynamo, logger())
    ).resolves.toEqual({
      claimed: false,
      failure: {
        phase: "fire-in-progress",
        severity: "error",
        errorMessage: "Scheduled fire is still in progress",
        retryable: true,
      },
    })
  })

  it("surfaces DynamoDB claim failures as retryable", async () => {
    const dynamo = client({
      put: jest.fn().mockRejectedValue(new Error("throttled")),
    })

    await expect(
      claimScheduleFire(identity, TABLE, dynamo, logger())
    ).resolves.toEqual({
      claimed: false,
      failure: {
        phase: "fire-acquire",
        severity: "error",
        errorMessage: "Schedule fire claim failed: throttled",
        retryable: true,
      },
    })
  })

  it("marks success idempotently and conditionally releases failures", async () => {
    const dynamo = client()
    const claim = {
      claimed: true as const,
      identity,
      claimToken: "owned-token",
    }

    await completeScheduleFire(claim, TABLE, dynamo, logger())
    await releaseScheduleFire(claim, TABLE, dynamo, logger())

    expect(dynamo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: { sessionId: identity.key },
        ConditionExpression: "lockToken = :token",
        ExpressionAttributeValues: expect.objectContaining({
          ":completed": "completed",
          ":token": "owned-token",
        }),
      })
    )
    expect(dynamo.delete).toHaveBeenCalledWith({
      TableName: TABLE,
      Key: { sessionId: identity.key },
      ConditionExpression: "lockToken = :token",
      ExpressionAttributeValues: { ":token": "owned-token" },
    })
  })
})

describe("agent-cron scheduled fire durability", () => {
  it("does not acknowledge a failed completion marker write", async () => {
    const dynamo = client({
      update: jest.fn().mockRejectedValue(new Error("DynamoDB throttled")),
    })
    const claim = {
      claimed: true as const,
      identity,
      claimToken: "owned-token",
    }

    await expect(
      completeScheduleFire(claim, TABLE, dynamo, logger())
    ).rejects.toThrow(
      "Schedule fire completion marker failed: DynamoDB throttled"
    )
  })

  it("expires a failed claim immediately when conditional delete fails", async () => {
    const dynamo = client({
      delete: jest.fn().mockRejectedValue(new Error("delete throttled")),
    })
    const claim = {
      claimed: true as const,
      identity,
      claimToken: "owned-token",
    }

    await expect(
      releaseScheduleFire(claim, TABLE, dynamo, logger())
    ).resolves.toBeUndefined()
    expect(dynamo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: { sessionId: identity.key },
        UpdateExpression: "SET #status = :failed, expiresAt = :expiredAt",
        ConditionExpression: "lockToken = :token",
        ExpressionAttributeValues: expect.objectContaining({
          ":failed": "failed",
          ":token": "owned-token",
        }),
      })
    )
  })

  it("propagates cleanup failure when delete and expiry both fail", async () => {
    const dynamo = client({
      delete: jest.fn().mockRejectedValue(new Error("delete unavailable")),
      update: jest.fn().mockRejectedValue(new Error("update unavailable")),
    })
    const claim = {
      claimed: true as const,
      identity,
      claimToken: "owned-token",
    }

    await expect(
      releaseScheduleFire(claim, TABLE, dynamo, logger())
    ).rejects.toThrow(
      "Schedule fire cleanup failed: delete unavailable; update unavailable"
    )
  })
})
