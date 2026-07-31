import {
  beginScheduleFireExecution,
  claimScheduleFire,
  completeScheduleFire,
  releaseScheduleFire,
  resolveScheduleLockContention,
  scheduleFireIdentity,
  scheduleFireLaunchIdentity,
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
    expect(
      scheduleFireIdentity({
        scheduleId: "x".repeat(129),
        scheduledTime: SCHEDULED_TIME,
      }),
    ).toBeNull()
  })

  it("derives an ECS identity from the immutable fire, not a lock token", () => {
    const first = scheduleFireLaunchIdentity(identity)
    const second = scheduleFireLaunchIdentity(identity)
    const other = scheduleFireLaunchIdentity({
      ...identity,
      key: `${identity.key}-other`,
    })
    expect(first).toEqual(second)
    expect(first).not.toEqual(other)
    expect(first.clientToken).toMatch(/^[a-f0-9]{64}$/)
    expect(first.startedBy).toBe(
      `scheduled-${first.clientToken.slice(0, 26)}`
    )
    expect(first.startedBy).toHaveLength(36)
  })

  it("starts with a short recoverable claim lease", async () => {
    const dynamo = client()
    const beforeClaim = Math.floor(Date.now() / 1000)
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
          status: "claimed",
          expiresAt: expect.any(Number),
        }),
        ConditionExpression:
          "attribute_not_exists(sessionId) OR expiresAt < :now",
        ExpressionAttributeValues: {
          ":now": expect.any(Number),
        },
      })
    )
    const putInput = (dynamo.put as jest.Mock).mock.calls[0][0]
    expect(putInput.Item.expiresAt).toBeGreaterThanOrEqual(beforeClaim + 5)
    expect(putInput.Item.expiresAt).toBeLessThan(beforeClaim + 60)
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
        recordRun: false,
      },
    })
  })

  it("distinguishes a fire whose external execution may have started", async () => {
    const contention = Object.assign(new Error("claimed"), {
      name: "ConditionalCheckFailedException",
    })
    const dynamo = client({
      put: jest.fn().mockRejectedValue(contention),
      get: jest.fn().mockResolvedValue({
        Item: { status: "executing" },
      }),
    })
    await expect(
      claimScheduleFire(identity, TABLE, dynamo, logger())
    ).resolves.toEqual({
      claimed: false,
      failure: {
        phase: "fire-executing",
        severity: "error",
        errorMessage:
          "Scheduled fire execution may have started; replay is blocked",
        retryable: true,
        recordRun: false,
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
        recordRun: true,
      },
    })
  })

})

describe("agent-cron scheduled fire lifecycle", () => {
  it("advances the owner to a long execution lease conditionally", async () => {
    const dynamo = client()
    const beforeExecution = Math.floor(Date.now() / 1000)
    const claim = {
      claimed: true as const,
      identity,
      claimToken: "owned-token",
    }

    await beginScheduleFireExecution(claim, TABLE, dynamo, logger())

    expect(dynamo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: { sessionId: identity.key },
        ConditionExpression: "lockToken = :token AND #status = :claimed",
        ExpressionAttributeValues: expect.objectContaining({
          ":claimed": "claimed",
          ":executing": "executing",
          ":expiresAt": expect.any(Number),
          ":token": "owned-token",
        }),
      })
    )
    const updateInput = (dynamo.update as jest.Mock).mock.calls[0][0]
    expect(updateInput.ExpressionAttributeValues[":expiresAt"])
      .toBeGreaterThanOrEqual(beforeExecution + 125 * 60)
  })

  it("stops a predecessor whose recoverable claim was replaced", async () => {
    const ownershipLost = Object.assign(new Error("replaced"), {
      name: "ConditionalCheckFailedException",
    })
    const dynamo = client({
      update: jest.fn().mockRejectedValue(ownershipLost),
    })
    const claim = {
      claimed: true as const,
      identity,
      claimToken: "stale-token",
    }

    await expect(
      beginScheduleFireExecution(claim, TABLE, dynamo, logger()),
    ).rejects.toMatchObject({
      name: "ScheduleFireExecutionError",
      failure: {
        phase: "fire-begin",
        retryable: true,
        recordRun: false,
      },
    })
  })

  it("marks success idempotently and conditionally releases failures", async () => {
    const dynamo = client()
    const beforeCompletion = Math.floor(Date.now() / 1000)
    const claim = {
      claimed: true as const,
      identity,
      claimToken: "owned-token",
    }
    await expect(
      completeScheduleFire(claim, TABLE, dynamo, logger())
    ).resolves.toEqual({ persisted: true })
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
    const updateInput = (dynamo.update as jest.Mock).mock.calls[0][0]
    expect(updateInput.ExpressionAttributeValues[":expiresAt"])
      .toBeGreaterThanOrEqual(beforeCompletion + 125 * 60)
    expect(dynamo.delete).toHaveBeenCalledWith({
      TableName: TABLE,
      Key: { sessionId: identity.key },
      ConditionExpression:
        "lockToken = :token AND #status = :claimed",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":token": "owned-token",
        ":claimed": "claimed",
      },
    })
  })
})

describe("agent-cron scheduled fire completion durability", () => {
  it("reports an undurable marker without replaying completed work", async () => {
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
    ).resolves.toEqual({
      persisted: false,
      errorMessage:
        "Schedule fire completion marker failed: update 1: DynamoDB throttled; update 2: DynamoDB throttled",
    })
    expect(dynamo.update).toHaveBeenCalledTimes(2)
  })

  it("recognizes an applied update after an ambiguous SDK failure", async () => {
    const dynamo = client({
      update: jest.fn().mockRejectedValue(new Error("socket reset")),
      get: jest.fn().mockResolvedValue({
        Item: {
          status: "completed",
          lockToken: "owned-token",
        },
      }),
    })
    const claim = {
      claimed: true as const,
      identity,
      claimToken: "owned-token",
    }

    await expect(
      completeScheduleFire(claim, TABLE, dynamo, logger())
    ).resolves.toEqual({ persisted: true })
    expect(dynamo.update).toHaveBeenCalledTimes(1)
  })

  it("retries only the marker write after a transient failure", async () => {
    const update = jest
      .fn()
      .mockRejectedValueOnce(new Error("DynamoDB throttled"))
      .mockResolvedValueOnce({})
    const dynamo = client({ update })
    const claim = {
      claimed: true as const,
      identity,
      claimToken: "owned-token",
    }

    await expect(
      completeScheduleFire(claim, TABLE, dynamo, logger())
    ).resolves.toEqual({ persisted: true })
    expect(update).toHaveBeenCalledTimes(2)
  })
})

describe("agent-cron scheduled fire release durability", () => {
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
        ConditionExpression:
          "lockToken = :token AND #status = :claimed",
        ExpressionAttributeValues: expect.objectContaining({
          ":failed": "failed",
          ":token": "owned-token",
          ":claimed": "claimed",
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

describe("agent-cron daily-session contention policy", () => {
  const contention = {
    acquired: false as const,
    phase: "lock-contention" as const,
    severity: "warn" as const,
    errorMessage: "Scheduled turn lock is already held",
    ownerFireKey:
      `schedule-fire#${SCHEDULE_ID}#2026-07-28T14:55:00.000Z`,
  }
  const fireClaim = {
    claimed: true as const,
    identity,
    claimToken: "owned-token",
  }

  it("coalesces a distinct identified fire with explicit telemetry detail", () => {
    expect(resolveScheduleLockContention(contention, fireClaim)).toEqual({
      action: "coalesce",
      fireClaim,
      failure: {
        ...contention,
        errorMessage:
          "Scheduled fire was coalesced because the same schedule is still active",
      },
    })
  })

  it("retries a different schedule sharing the owner workspace lock", () => {
    const otherScheduleContention = {
      ...contention,
      ownerFireKey:
        "schedule-fire#another-schedule#2026-07-28T14:55:00.000Z",
    }

    expect(
      resolveScheduleLockContention(otherScheduleContention, fireClaim),
    ).toEqual({
      action: "retry",
      fireClaim,
      failure: {
        ...otherScheduleContention,
        severity: "error",
        errorMessage:
          "Owner workspace is active for another schedule; retrying this fire",
      },
    })
  })

  it("retries when the contended session lock belongs to the same fire", () => {
    expect(
      resolveScheduleLockContention(
        { ...contention, ownerFireKey: identity.key },
        fireClaim,
      ),
    ).toEqual({
      action: "retry",
      fireClaim,
      failure: {
        ...contention,
        ownerFireKey: identity.key,
        severity: "error",
        errorMessage:
          "Scheduled fire session lock is owned by the same fire; retrying",
      },
    })
  })

  it("retries legacy contention that could be a same-fire redelivery", () => {
    expect(resolveScheduleLockContention(contention, null)).toEqual({
      action: "retry",
      failure: {
        ...contention,
        severity: "error",
        errorMessage:
          "Legacy scheduled fire contended; retrying without acknowledging",
      },
    })
  })
})
