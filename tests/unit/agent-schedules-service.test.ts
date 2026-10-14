jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class DynamoDBClient {},
}))
jest.mock("@aws-sdk/lib-dynamodb", () => {
  class Command {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    DeleteCommand: class DeleteCommand extends Command {},
    GetCommand: class GetCommand extends Command {},
    PutCommand: class PutCommand extends Command {},
    QueryCommand: class QueryCommand extends Command {},
    TransactWriteCommand: class TransactWriteCommand extends Command {},
    DynamoDBDocumentClient: { from: jest.fn() },
  }
})
jest.mock("@aws-sdk/client-scheduler", () => {
  class Command {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    CreateScheduleCommand: class CreateScheduleCommand extends Command {},
    DeleteScheduleCommand: class DeleteScheduleCommand extends Command {},
    UpdateScheduleCommand: class UpdateScheduleCommand extends Command {},
    ResourceNotFoundException: class ResourceNotFoundException extends Error {},
    SchedulerClient: class SchedulerClient {},
  }
})

import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler"
import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb"
import {
  AgentScheduleConflictError,
  AgentScheduleNameConflictError,
  AgentSchedulePossibleDuplicateError,
  AgentScheduleQuotaError,
  AgentScheduleService,
  AgentScheduleSyncError,
  scheduleTransactionToken,
  type AgentScheduleDynamoClient,
  type AgentScheduleRecord,
} from "@/lib/agent-schedules/service"
import type {
  AgentScheduleLastRun,
  AgentScheduleRunReader,
} from "@/lib/agent-schedules/run-reader"
import {
  AgentScheduleInputError,
  toSchedulerExpression,
} from "@/lib/agent-schedules/validation"

const OWNER = "owner@psd401.net"
const SCHEDULE_ID = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
const LEGACY_SCHEDULE_ID = "5123b45b"

const config = {
  region: "us-east-1",
  environment: "dev",
  schedulesTable: "schedules",
  usersTable: "users",
  scheduleGroup: "psd-agent-dev",
  cronLambdaArn: "arn:aws:lambda:us-east-1:123:function:cron",
  schedulerRoleArn: "arn:aws:iam::123:role/scheduler",
  scheduleDlqArn: "arn:aws:sqs:us-east-1:123:schedule-dlq",
  maxSchedulesPerOwner: 50,
}

function scheduleRecord(
  overrides: Partial<AgentScheduleRecord> = {}
): AgentScheduleRecord {
  return {
    userId: OWNER,
    ownerEmail: OWNER,
    scheduleId: SCHEDULE_ID,
    version: 1,
    name: "Morning brief",
    prompt: "Summarize my day",
    cronExpression: "0 8 * * *",
    schedulerExpression: "cron(0 8 * * ? *)",
    timezone: "America/Los_Angeles",
    enabled: true,
    googleIdentity: "users/12345",
    dmSpaceName: "spaces/trusted-owner-dm",
    displayName: "Owner",
    workspacePrefix: "owner-workspace",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  }
}

function harness(
  latestRuns: Map<string, AgentScheduleLastRun> = new Map(),
) {
  const dynamoSend = jest.fn()
  const schedulerSend = jest.fn()
  const latestBySchedule = jest.fn().mockResolvedValue(latestRuns)
  const recentForOwner = jest.fn().mockResolvedValue([])
  const service = new AgentScheduleService(
    config,
    { send: dynamoSend } as unknown as AgentScheduleDynamoClient,
    { send: schedulerSend } as unknown as SchedulerClient,
    { latestBySchedule, recentForOwner } as AgentScheduleRunReader,
  )
  return { service, dynamoSend, schedulerSend, latestBySchedule, recentForOwner }
}

function defineAgentScheduleServiceAuthorityBoundarySuite1Part1() {
  it("creates a target with a reference and Scheduler fire identity", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [
          {
            email: OWNER,
            googleIdentity: "users/12345",
            dmSpaceName: "spaces/trusted-owner-dm",
            displayName: "Owner",
            workspacePrefix: "owner-workspace",
          },
        ],
      })
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValueOnce({})

    const created = await service.create(OWNER, {
      name: "Morning brief",
      prompt: "Summarize my day",
      cron: "0 8 * * *",
      timezone: "America/Los_Angeles",
    })

    const createCommand = schedulerSend.mock.calls[0][0]
    expect(createCommand).toBeInstanceOf(CreateScheduleCommand)
    const target = (createCommand as CreateScheduleCommand).input.Target
    expect(JSON.parse(target?.Input ?? "{}")).toEqual({
      ownerEmail: OWNER,
      scheduleId: created.scheduleId,
      version: 1,
      scheduledTime: "<aws.scheduler.scheduled-time>",
    })
    expect(target?.Input).not.toContain("prompt")
    expect(target?.Input).not.toContain("dmSpaceName")
    expect(target?.DeadLetterConfig).toEqual({
      Arn: config.scheduleDlqArn,
    })
    expect(target?.RetryPolicy).toEqual({
      MaximumEventAgeInSeconds: 3600,
      MaximumRetryAttempts: 5,
    })

    const transaction = dynamoSend.mock.calls[3][0]
    expect(transaction).toBeInstanceOf(TransactWriteCommand)
    const recordPut = (transaction as TransactWriteCommand).input
      .TransactItems?.[2]?.Put
    expect(recordPut?.Item).toMatchObject({
      ownerEmail: OWNER,
      userId: OWNER,
      dmSpaceName: "spaces/trusted-owner-dm",
      googleIdentity: "users/12345",
    })
    expect(created).not.toHaveProperty("ownerEmail")
    expect(created).not.toHaveProperty("dmSpaceName")
    expect(created.scheduleId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it("refreshes destination from the trusted owner row and versions updates", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: scheduleRecord() })
      .mockResolvedValueOnce({
        Items: [
          {
            email: OWNER,
            googleIdentity: "users/67890",
            dmSpaceName: "spaces/new-trusted-dm",
            workspacePrefix: "owner-workspace",
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValueOnce({})

    const updated = await service.update(OWNER, {
      scheduleId: SCHEDULE_ID,
      prompt: "New prompt",
    })
    expect(updated.version).toBe(2)
    const updateCommand = schedulerSend.mock.calls[0][0]
    expect(updateCommand).toBeInstanceOf(UpdateScheduleCommand)
    expect(
      JSON.parse(
        (updateCommand as UpdateScheduleCommand).input.Target?.Input ?? "{}"
      )
    ).toEqual({
      ownerEmail: OWNER,
      scheduleId: SCHEDULE_ID,
      version: 2,
      scheduledTime: "<aws.scheduler.scheduled-time>",
    })
    expect((updateCommand as UpdateScheduleCommand).input.Target).toMatchObject({
      DeadLetterConfig: { Arn: config.scheduleDlqArn },
      RetryPolicy: {
        MaximumEventAgeInSeconds: 3600,
        MaximumRetryAttempts: 5,
      },
    })
    const putCommand = dynamoSend.mock.calls[5][0] as PutCommand
    expect(putCommand.input.Item).toMatchObject({
      dmSpaceName: "spaces/new-trusted-dm",
      googleIdentity: "users/67890",
      version: 2,
    })
    const lockPut = dynamoSend.mock.calls[2][0] as PutCommand
    expect(lockPut.input.Item).toMatchObject({
      userId: OWNER,
      scheduleId: `__mutation__${SCHEDULE_ID}`,
      kind: "schedule-mutation-lock",
    })
    expect(dynamoSend.mock.calls[6][0]).toBeInstanceOf(DeleteCommand)
  })

  it("updates a preserved legacy hexadecimal schedule ID", async () => {
    const legacyRecord = scheduleRecord({ scheduleId: LEGACY_SCHEDULE_ID })
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [legacyRecord] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: legacyRecord })
      .mockResolvedValueOnce({
        Items: [{
          email: OWNER,
          dmSpaceName: "spaces/trusted-owner-dm",
          workspacePrefix: "owner-workspace",
        }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValueOnce({})

    await expect(service.update(OWNER, {
      scheduleId: LEGACY_SCHEDULE_ID,
      prompt: "Updated legacy prompt",
    })).resolves.toMatchObject({
      scheduleId: LEGACY_SCHEDULE_ID,
      version: 2,
    })

    const update = schedulerSend.mock.calls[0][0] as UpdateScheduleCommand
    expect(update.input.Name).toBe(`psd-agent-dev-${LEGACY_SCHEDULE_ID}`)
    expect(JSON.parse(update.input.Target?.Input ?? "{}")).toMatchObject({
      scheduleId: LEGACY_SCHEDULE_ID,
      version: 2,
    })
  })

  }

function defineAgentScheduleServiceAuthorityBoundarySuite1Part2() {it("rolls back EventBridge when authoritative persistence fails", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [{ email: OWNER, dmSpaceName: "spaces/trusted-owner-dm" }],
      })
      .mockRejectedValueOnce(new Error("ddb failed"))
    schedulerSend.mockResolvedValue({})

    await expect(
      service.create(OWNER, {
        name: "Brief",
        prompt: "Prompt",
        cron: "0 8 * * *",
      })
    ).rejects.toThrow("ddb failed")
    expect(schedulerSend.mock.calls[0][0]).toBeInstanceOf(
      CreateScheduleCommand
    )
    expect(schedulerSend.mock.calls[1][0]).toBeInstanceOf(
      DeleteScheduleCommand
    )
  })

  it("always uses the owner as the DynamoDB partition key", async () => {
    const { service, dynamoSend } = harness()
    dynamoSend.mockResolvedValueOnce({ Items: [] })
    await service.list(OWNER)
    const query = dynamoSend.mock.calls[0][0]
    expect(query).toBeInstanceOf(QueryCommand)
    expect((query as QueryCommand).input.ExpressionAttributeValues).toEqual({
      ":owner": OWNER,
    })
  })

  it("paginates the complete owner partition", async () => {
    const { service, dynamoSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({
        Items: [scheduleRecord()],
        LastEvaluatedKey: { userId: OWNER, scheduleId: SCHEDULE_ID },
      })
      .mockResolvedValueOnce({
        Items: [
          scheduleRecord({
            scheduleId: "a273413f-7a93-4e43-9b49-1bc8880be024",
            name: "Second",
            createdAt: "2026-07-26T00:00:00.000Z",
          }),
        ],
      })
    await expect(service.list(OWNER)).resolves.toHaveLength(2)
    expect(
      (dynamoSend.mock.calls[1][0] as QueryCommand).input.ExclusiveStartKey,
    ).toEqual({ userId: OWNER, scheduleId: SCHEDULE_ID })
  })

  it("returns a degraded legacy row alongside valid schedules", async () => {
    const legacyId = "a273413f-7a93-4e43-9b49-1bc8880be024"
    const { service, dynamoSend, latestBySchedule } = harness()
    dynamoSend.mockResolvedValueOnce({
      Items: [
        {
          userId: OWNER,
          scheduleId: legacyId,
          name: "Legacy dispatch",
          prompt: "Generate it",
          cronExpression: "0 6 * * MON-FRI",
          timezone: "America/Los_Angeles",
          enabled: true,
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        },
        scheduleRecord(),
      ],
    })

    await expect(service.list(OWNER)).resolves.toEqual([
      expect.objectContaining({
        scheduleId: legacyId,
        version: 0,
        name: "Legacy dispatch",
        degraded: true,
        degradedReason: "Schedule record requires migration",
      }),
      expect.objectContaining({
        scheduleId: SCHEDULE_ID,
        degraded: false,
        degradedReason: null,
      }),
    ])
    expect(latestBySchedule).toHaveBeenCalledWith(OWNER, [
      legacyId,
      SCHEDULE_ID,
    ])
  })

  it("joins each schedule to its latest run and truncates the error", async () => {
    const latestRunAt = new Date("2026-07-28T15:30:00.000Z")
    const longError = "failure ".repeat(100)
    const { service, dynamoSend, latestBySchedule } = harness(
      new Map([
        [
          SCHEDULE_ID,
          {
            createdAt: latestRunAt,
            status: "error",
            errorMessage: longError,
          },
        ],
      ]),
    )
    dynamoSend.mockResolvedValueOnce({
      Items: [
        scheduleRecord(),
        scheduleRecord({
          scheduleId: "a273413f-7a93-4e43-9b49-1bc8880be024",
          name: "Never run",
          createdAt: "2026-07-26T00:00:00.000Z",
        }),
      ],
    })

    const schedules = await service.list(OWNER)

    expect(latestBySchedule).toHaveBeenCalledWith(OWNER, [
      SCHEDULE_ID,
      "a273413f-7a93-4e43-9b49-1bc8880be024",
    ])
    expect(schedules[0]).toMatchObject({
      lastRunAt: latestRunAt.toISOString(),
      lastRunStatus: "error",
      lastRunError: longError.slice(0, 500),
    })
    expect(schedules[1]).toMatchObject({
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
    })
  })

  it("marks run status unknown when telemetry is unavailable", async () => {
    const { service, dynamoSend, latestBySchedule } = harness()
    dynamoSend.mockResolvedValueOnce({ Items: [scheduleRecord()] })
    latestBySchedule.mockRejectedValueOnce(new Error("Aurora unavailable"))

    await expect(service.list(OWNER)).resolves.toEqual([
      expect.objectContaining({
        scheduleId: SCHEDULE_ID,
        lastRunAt: null,
        lastRunStatus: "unknown",
        lastRunError: null,
      }),
    ])
  })
}

function defineAgentScheduleServiceAuthorityBoundarySuite1Part2b() {
  it("seeds legacy quota from all existing rows before admitting a create", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    const legacy = Array.from({ length: config.maxSchedulesPerOwner }, (_, i) =>
      scheduleRecord({
        scheduleId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        name: `Legacy ${i}`,
      }),
    )
    const quotaFailure = Object.assign(new Error("at quota"), {
      name: "TransactionCanceledException",
    })
    dynamoSend
      .mockResolvedValueOnce({ Items: legacy })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [{ email: OWNER, dmSpaceName: "spaces/trusted-owner-dm" }],
      })
      .mockRejectedValueOnce(quotaFailure)
      // The name-guard probe finds no row for "Over quota", so the cancelled
      // condition was the quota one.
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValue({})

    await expect(
      service.create(OWNER, {
        name: "Over quota",
        prompt: "No",
        cron: "0 8 * * *",
      }),
    ).rejects.toThrow("maximum 50")
    const reconciliation = dynamoSend.mock.calls[1][0] as TransactWriteCommand
    expect(
      reconciliation.input.TransactItems?.[0]?.Put?.Item,
    ).toMatchObject({ activeCount: 50, reconciled: true })
  })

}

function defineAgentScheduleServiceAuthorityBoundarySuite1Part3() {it("repairs a reconciled but drifted quota on a subsequent mutation", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    const quota = {
      userId: OWNER,
      scheduleId: "__quota__",
      activeCount: 0,
      reconciled: true,
    }
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord(), quota] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: scheduleRecord() })
      .mockResolvedValueOnce({
        Items: [{ email: OWNER, dmSpaceName: "spaces/trusted-owner-dm" }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValueOnce({})

    await service.update(OWNER, {
      scheduleId: SCHEDULE_ID,
      prompt: "Repair metadata",
    })

    const reconciliation = dynamoSend.mock.calls[1][0] as TransactWriteCommand
    expect(reconciliation.input.TransactItems?.[0]?.Put).toMatchObject({
      Item: expect.objectContaining({ activeCount: 1, reconciled: true }),
      ConditionExpression:
        "reconciled = :true AND activeCount = :previous",
      ExpressionAttributeValues: { ":true": true, ":previous": 0 },
    })
  })

  it("disables execution before atomically removing schedule metadata", async () => {
    const events: string[] = []
    const dynamoSend = jest.fn(async () => {
      events.push("dynamo")
      const index = events.filter((event) => event === "dynamo").length
      if (index === 1) return { Items: [scheduleRecord()] }
      if (index === 2) return {}
      if (index === 4) return { Item: scheduleRecord() }
      return {}
    })
    const schedulerSend = jest.fn(async () => {
      events.push("scheduler")
      return {}
    })
    const service = new AgentScheduleService(
      config,
      { send: dynamoSend } as unknown as AgentScheduleDynamoClient,
      { send: schedulerSend } as unknown as SchedulerClient,
      {
        recentForOwner: jest.fn().mockResolvedValue([]),
        latestBySchedule: jest.fn().mockResolvedValue(new Map()),
      },
    )
    await expect(service.delete(OWNER, SCHEDULE_ID)).resolves.toBe(SCHEDULE_ID)
    expect(events).toEqual([
      "dynamo",
      "dynamo",
      "dynamo",
      "dynamo",
      "scheduler",
      "dynamo",
      "dynamo",
    ])
  })

  it("deletes a preserved legacy hexadecimal schedule ID", async () => {
    const legacyRecord = scheduleRecord({ scheduleId: LEGACY_SCHEDULE_ID })
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [legacyRecord] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: legacyRecord })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValueOnce({})

    await expect(
      service.delete(OWNER, LEGACY_SCHEDULE_ID),
    ).resolves.toBe(LEGACY_SCHEDULE_ID)
    const deletion = schedulerSend.mock.calls[0][0] as DeleteScheduleCommand
    expect(deletion.input.Name).toBe(`psd-agent-dev-${LEGACY_SCHEDULE_ID}`)
  })

  it("keeps metadata retryable when scheduler deletion fails", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: scheduleRecord() })
      .mockResolvedValueOnce({})
    schedulerSend.mockRejectedValueOnce(new Error("scheduler unavailable"))

    await expect(service.delete(OWNER, SCHEDULE_ID)).rejects.toThrow(
      "retry the delete",
    )
    expect(dynamoSend).toHaveBeenCalledTimes(5)
  })

  it("rejects a user mutation while the deployment backfill owns its lock", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    const contention = Object.assign(new Error("locked"), {
      name: "ConditionalCheckFailedException",
    })
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(contention)

    await expect(
      service.update(OWNER, {
        scheduleId: SCHEDULE_ID,
        prompt: "Concurrent edit",
      }),
    ).rejects.toThrow("being updated")
    expect(schedulerSend).not.toHaveBeenCalled()
  })

  it("uses deterministic DynamoDB idempotency tokens within the 36-char limit", () => {
    for (const operation of ["create", "update", "delete", "reconcile"] as const) {
      const token = scheduleTransactionToken(operation, SCHEDULE_ID, 123_456)
      expect(token).toHaveLength(36)
      expect(token).toMatch(/^[a-f0-9]{36}$/)
      expect(scheduleTransactionToken(operation, SCHEDULE_ID, 123_456)).toBe(
        token,
      )
    }
  })

  it("rejects records whose stored owner does not match the signed owner", async () => {
    const { service, dynamoSend } = harness()
    dynamoSend.mockResolvedValueOnce({
      Items: [scheduleRecord({
        ownerEmail: "victim@psd401.net",
        userId: "victim@psd401.net",
      })],
    })
    await expect(
      service.update(OWNER, {
        scheduleId: SCHEDULE_ID,
        prompt: "attacker prompt",
      })
    ).rejects.toThrow("owner or integrity")
    expect(dynamoSend.mock.calls[0][0]).toBeInstanceOf(QueryCommand)
  })
}

const defineAgentScheduleServiceAuthorityBoundarySuite1 = () => {
  defineAgentScheduleServiceAuthorityBoundarySuite1Part1()
  defineAgentScheduleServiceAuthorityBoundarySuite1Part2()
  defineAgentScheduleServiceAuthorityBoundarySuite1Part2b()
  defineAgentScheduleServiceAuthorityBoundarySuite1Part3()
};

describe("AgentScheduleService authority boundary", defineAgentScheduleServiceAuthorityBoundarySuite1)

const defineScheduleExpressionResourceGuardsSuite2 = () => {
  it.each(["* * * * *", "*/1 * * * *", "rate(4 minutes)"])(
    "rejects excessive frequency: %s",
    (expression) => {
      expect(() => toSchedulerExpression(expression)).toThrow(
        AgentScheduleInputError
      )
    }
  )

  it("normalizes a five-field weekday cron", () => {
    expect(toSchedulerExpression("0 9 * * MON-FRI")).toBe(
      "cron(0 9 ? * MON-FRI *)"
    )
  })
};

describe("schedule expression resource guards", defineScheduleExpressionResourceGuardsSuite2)

// `list` reports a status but never a reason, so an agent asked "why did my
// nightly job fail" had nothing to answer with and told the user it could not
// see that job's logs (prod 2026-08-06, agent_failures 2580).
describe("schedule run history", () => {
  it("returns the owner's recent runs, error messages included", async () => {
    const { service, recentForOwner } = harness()
    recentForOwner.mockResolvedValue([
      {
        scheduleId: "s1",
        scheduleName: "Nightly inbox filing",
        createdAt: new Date("2026-08-06T05:01:00Z"),
        status: "error",
        errorMessage: "exec was still running",
        latencyMs: 1200,
      },
    ])
    const runs = await service.runs("Owner@PSD401.net")
    expect(runs).toHaveLength(1)
    expect(runs[0].errorMessage).toBe("exec was still running")
    // Owner is normalised before it reaches the reader, so a caller cannot
    // reach another owner's rows by varying case.
    expect(recentForOwner).toHaveBeenCalledWith("owner@psd401.net", {
      scheduleId: undefined,
      limit: undefined,
    })
  })

  it("passes a narrowing scheduleId and limit through", async () => {
    const { service, recentForOwner } = harness()
    recentForOwner.mockResolvedValue([])
    await service.runs("owner@psd401.net", { scheduleId: " s1 ", limit: 5 })
    expect(recentForOwner).toHaveBeenCalledWith("owner@psd401.net", {
      scheduleId: "s1",
      limit: 5,
    })
  })

  it("ignores non-string scheduleId and non-numeric limit", async () => {
    const { service, recentForOwner } = harness()
    recentForOwner.mockResolvedValue([])
    await service.runs("owner@psd401.net", { scheduleId: 42, limit: "many" })
    expect(recentForOwner).toHaveBeenCalledWith("owner@psd401.net", {
      scheduleId: undefined,
      limit: undefined,
    })
  })

  it("ignores a fractional limit rather than forwarding it to the database", async () => {
    // 1.5 survives a finite-only check and the reader's clamp, reaching Drizzle's
    // .limit() as a fraction — a runtime error, not a smaller page.
    const { service, recentForOwner } = harness()
    recentForOwner.mockResolvedValue([])
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await service.runs("owner@psd401.net", { limit: bad })
      expect(recentForOwner).toHaveBeenLastCalledWith("owner@psd401.net", {
        scheduleId: undefined,
        limit: undefined,
      })
    }
  })
})

/**
 * Duplicate and name-collision refusals (#1889).
 *
 * `create` used to map every TransactionCanceledException to the quota error,
 * so a name collision read as "Schedule quota exceeded (maximum 50)" and the
 * agent retried under a new name — four near-identical form watchers in one
 * counselor's account in a single day.
 */
const OWNER_ROW_RESPONSE = {
  Items: [{ email: OWNER, dmSpaceName: "spaces/trusted-owner-dm" }],
}

function cancellation() {
  return Object.assign(new Error("cancelled"), {
    name: "TransactionCanceledException",
  })
}

/** Split only to stay under the max-lines-per-function lint budget. */
function defineNameCollisionMappingSuite() {
  it("reports a name collision as a conflict carrying the existing id", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockRejectedValueOnce(cancellation())
      .mockResolvedValueOnce({ Item: { targetScheduleId: SCHEDULE_ID } })
    schedulerSend.mockResolvedValue({})

    const error = await service
      .create(OWNER, {
        // Same name as the existing record, deliberately different prompt so
        // this reaches the name guard rather than the duplicate check.
        name: "Morning brief",
        prompt: "Something else entirely",
        cron: "0 15 * * *",
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentScheduleNameConflictError)
    expect(error).toBeInstanceOf(AgentScheduleConflictError)
    expect(error).not.toBeInstanceOf(AgentScheduleQuotaError)
    expect((error as AgentScheduleNameConflictError).message).toContain(
      "Morning brief",
    )
    expect((error as AgentScheduleNameConflictError).details).toEqual({
      code: "name_conflict",
      existingScheduleId: SCHEDULE_ID,
    })
    // The orphaned EventBridge schedule is still rolled back.
    expect(schedulerSend.mock.calls[1][0]).toBeInstanceOf(DeleteScheduleCommand)
  })

  it("still reports quota exhaustion when the quota condition is the one that failed", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockRejectedValueOnce(cancellation())
      // No guard row: the name-guard condition would have succeeded, so the
      // cancellation was the quota one.
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValue({})

    const error = await service
      .create(OWNER, {
        name: "Over quota",
        prompt: "No room",
        cron: "0 8 * * *",
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentScheduleQuotaError)
    expect((error as Error).message).toContain("maximum 50")
    expect(dynamoSend).toHaveBeenCalledTimes(5)
  })

  it("refuses to guess at quota when the guard probe itself fails", async () => {
    // A transient failure on the diagnostic read must not come back out as
    // "quota exceeded" — that is the #1889 bug with a new trigger, and it
    // would push the agent to rename or to delete a live schedule.
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockRejectedValueOnce(cancellation())
      .mockRejectedValueOnce(new Error("ProvisionedThroughputExceeded"))
    schedulerSend.mockResolvedValue({})

    const error = await service
      .create(OWNER, {
        name: "Morning brief",
        prompt: "Something else entirely",
        cron: "0 15 * * *",
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentScheduleSyncError)
    expect(error).not.toBeInstanceOf(AgentScheduleQuotaError)
  })

  it("treats a guard row with no readable target as a taken name, not a free one", async () => {
    // The row's presence is what proves the name is occupied. Reading a
    // malformed row as "no row" would hand back the quota error again —
    // #1889's exact failure, just reached through a corrupt record.
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockRejectedValueOnce(cancellation())
      .mockResolvedValueOnce({ Item: { targetScheduleId: 42 } })
    schedulerSend.mockResolvedValue({})

    const error = await service
      .create(OWNER, {
        name: "Morning brief",
        prompt: "Something else entirely",
        cron: "0 15 * * *",
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentScheduleNameConflictError)
    expect(error).not.toBeInstanceOf(AgentScheduleQuotaError)
    expect((error as AgentScheduleNameConflictError).details).toEqual({
      code: "name_conflict",
      existingScheduleId: null,
    })
  })

  it("pins the TransactWrite item order the create conditions rely on", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValue({})

    await service.create(OWNER, {
      name: "Morning brief",
      prompt: "Summarize my day",
      cron: "0 8 * * *",
    })

    const transaction = dynamoSend.mock.calls[3][0] as TransactWriteCommand
    const items = transaction.input.TransactItems ?? []
    expect(items[0]?.Update?.Key).toMatchObject({ scheduleId: "__quota__" })
    expect(items[1]?.Put?.Item?.scheduleId).toMatch(/^__name__/)
    expect(items[2]?.Put?.Item).toMatchObject({ name: "Morning brief" })
  })

}

function defineLikelyDuplicateSuite() {
  it("refuses a likely duplicate before touching EventBridge", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValue({})

    const error = await service
      .create(OWNER, {
        // A different name, the same job: whitespace and case differences in
        // the prompt must not buy the agent a second schedule.
        name: "Morning brief v2",
        prompt: "  summarize   MY day  ",
        cron: "0 8 * * *",
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentSchedulePossibleDuplicateError)
    expect((error as AgentSchedulePossibleDuplicateError).details).toEqual({
      code: "possible_duplicate",
      existingScheduleId: SCHEDULE_ID,
      existingScheduleName: "Morning brief",
    })
    expect(schedulerSend).not.toHaveBeenCalled()
  })

  it("compares only the first 200 normalized prompt characters", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    const base = "a".repeat(200)
    dynamoSend
      .mockResolvedValueOnce({
        Items: [scheduleRecord({ prompt: `${base} tail one` })],
      })
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValue({})

    await expect(
      service.create(OWNER, {
        name: "Different name",
        prompt: `${base} a completely different tail`,
        cron: "0 8 * * *",
      }),
    ).rejects.toBeInstanceOf(AgentSchedulePossibleDuplicateError)
  })

  it("allows a second copy when confirmNew is passed", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValue({})

    await expect(
      service.create(OWNER, {
        name: "Morning brief v2",
        prompt: "Summarize my day",
        cron: "0 8 * * *",
        confirmNew: true,
      }),
    ).resolves.toMatchObject({ name: "Morning brief v2" })
    expect(schedulerSend.mock.calls[0][0]).toBeInstanceOf(CreateScheduleCommand)
  })

  it("does not treat a disabled schedule as a duplicate", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord({ enabled: false })] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValue({})

    await expect(
      service.create(OWNER, {
        name: "Morning brief v2",
        prompt: "Summarize my day",
        cron: "0 8 * * *",
      }),
    ).resolves.toMatchObject({ name: "Morning brief v2" })
  })

  it("does not treat the same cron in another timezone as a duplicate", async () => {
    // Same cron text, three hours apart on the clock. Two campuses on two
    // coasts is a real schedule pair, and refusing it would force the agent to
    // reach for --confirm-new on a legitimate create.
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValue({})

    await expect(
      service.create(OWNER, {
        name: "Morning brief East",
        prompt: "Summarize my day",
        cron: "0 8 * * *",
        timezone: "America/New_York",
      }),
    ).resolves.toMatchObject({ name: "Morning brief East" })
  })

  it("does not treat a different cadence as a duplicate", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValue({})

    await expect(
      service.create(OWNER, {
        name: "Afternoon brief",
        prompt: "Summarize my day",
        cron: "0 15 * * *",
      }),
    ).resolves.toMatchObject({ name: "Afternoon brief" })
  })

  it("rejects a non-boolean confirmNew rather than coercing it", async () => {
    const { service } = harness()
    await expect(
      service.create(OWNER, {
        name: "Brief",
        prompt: "Prompt",
        cron: "0 8 * * *",
        confirmNew: "yes",
      }),
    ).rejects.toBeInstanceOf(AgentScheduleInputError)
  })
}

/**
 * Classification from the exception's own per-item reasons.
 *
 * Re-probing the guard row after the fact loses to a concurrent delete of the
 * colliding schedule: the row is gone by probe time, so the cancellation reads
 * as "quota" — #1889's wrong error, reached through a race instead of
 * unconditionally. The reasons travel with the exception and cannot race.
 */
function cancellationWithReasons(codes: string[]) {
  return Object.assign(new Error("cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  })
}

function defineCancellationReasonSuite() {
  it("reads a name collision off the cancellation reasons, not a second probe", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockRejectedValueOnce(
        cancellationWithReasons(["None", "ConditionalCheckFailed", "None"]),
      )
      .mockResolvedValueOnce({ Item: { targetScheduleId: SCHEDULE_ID } })
    schedulerSend.mockResolvedValue({})

    const error = await service
      .create(OWNER, {
        name: "Morning brief",
        prompt: "Something else entirely",
        cron: "0 15 * * *",
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentScheduleNameConflictError)
    expect((error as AgentScheduleNameConflictError).details).toEqual({
      code: "name_conflict",
      existingScheduleId: SCHEDULE_ID,
    })
  })

  it("still reports the collision when the id probe races a delete", async () => {
    // The guard row is gone by probe time. Classification came from the
    // reasons, so the agent is told the name is taken and loses only the id —
    // rather than being told its quota is full.
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockRejectedValueOnce(
        cancellationWithReasons(["None", "ConditionalCheckFailed", "None"]),
      )
      .mockResolvedValueOnce({})
    schedulerSend.mockResolvedValue({})

    const error = await service
      .create(OWNER, {
        name: "Morning brief",
        prompt: "Something else entirely",
        cron: "0 15 * * *",
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentScheduleNameConflictError)
    expect(error).not.toBeInstanceOf(AgentScheduleQuotaError)
    expect((error as AgentScheduleNameConflictError).details).toEqual({
      code: "name_conflict",
      existingScheduleId: null,
    })
  })

  it("reports quota from the reasons without probing the guard row at all", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockRejectedValueOnce(
        cancellationWithReasons(["ConditionalCheckFailed", "None", "None"]),
      )
    schedulerSend.mockResolvedValue({})

    const error = await service
      .create(OWNER, { name: "Over quota", prompt: "No room", cron: "0 8 * * *" })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentScheduleQuotaError)
    // Four calls, not five: the diagnostic read is skipped entirely.
    expect(dynamoSend).toHaveBeenCalledTimes(4)
  })
}

/**
 * The refusal on the paths that bypassed it (#1889 review).
 *
 * An identical retry under the same name has to come back as `name_conflict`
 * — `confirmNew` cannot clear that, so answering `possible_duplicate` sent the
 * agent round a second failed attempt. And `update` could disable, retime and
 * re-enable a schedule into a duplicate the create-time check refuses.
 */
const OTHER_SCHEDULE_ID = "7d1c4f0e-2b6a-4c39-9e51-3a8f0d2c6b14"

function defineDuplicateBypassSuite() {
  it("reports an identical same-name retry as name_conflict", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
      .mockRejectedValueOnce(
        cancellationWithReasons(["None", "ConditionalCheckFailed", "None"]),
      )
      .mockResolvedValueOnce({ Item: { targetScheduleId: SCHEDULE_ID } })
    schedulerSend.mockResolvedValue({})

    const error = await service
      .create(OWNER, {
        name: "  MORNING brief ",
        prompt: "Summarize my day",
        cron: "0 8 * * *",
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentScheduleNameConflictError)
    expect(error).not.toBeInstanceOf(AgentSchedulePossibleDuplicateError)
  })

  it("refuses an update that re-enables a schedule into a duplicate", async () => {
    const retired = scheduleRecord({
      scheduleId: OTHER_SCHEDULE_ID,
      name: "Old brief",
      cronExpression: "0 15 * * *",
      schedulerExpression: "cron(0 15 * * ? *)",
      enabled: false,
    })
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend.mockResolvedValue({})
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord(), retired] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: retired })
    schedulerSend.mockResolvedValue({})

    const error = await service
      .update(OWNER, {
        scheduleId: OTHER_SCHEDULE_ID,
        cron: "0 8 * * *",
        enabled: true,
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AgentSchedulePossibleDuplicateError)
    expect((error as AgentSchedulePossibleDuplicateError).details).toEqual({
      code: "possible_duplicate",
      existingScheduleId: SCHEDULE_ID,
      existingScheduleName: "Morning brief",
    })
    expect(schedulerSend).not.toHaveBeenCalled()
    const recordWrites = dynamoSend.mock.calls.filter(
      ([command]) =>
        command instanceof PutCommand &&
        command.input.Item?.scheduleId === OTHER_SCHEDULE_ID,
    )
    expect(recordWrites).toHaveLength(0)
  })

  it("lets an update through with confirmNew", async () => {
    const retired = scheduleRecord({
      scheduleId: OTHER_SCHEDULE_ID,
      name: "Old brief",
      enabled: false,
    })
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend.mockResolvedValue({})
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord(), retired] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: retired })
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
    schedulerSend.mockResolvedValue({})

    await expect(
      service.update(OWNER, {
        scheduleId: OTHER_SCHEDULE_ID,
        enabled: true,
        confirmNew: true,
      }),
    ).resolves.toMatchObject({ enabled: true })
    expect(schedulerSend.mock.calls[0][0]).toBeInstanceOf(UpdateScheduleCommand)
  })

  it("does not refuse a rename of a schedule that already has a twin", async () => {
    // A legacy pair that already double-fires must stay editable; only a
    // change that makes the schedule a running copy of another is refused.
    const twin = scheduleRecord({
      scheduleId: OTHER_SCHEDULE_ID,
      name: "Morning brief copy",
    })
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend.mockResolvedValue({})
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord(), twin] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: twin })
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
    schedulerSend.mockResolvedValue({})

    await expect(
      service.update(OWNER, {
        scheduleId: OTHER_SCHEDULE_ID,
        name: "Morning brief (to delete)",
      }),
    ).resolves.toMatchObject({ name: "Morning brief (to delete)" })
  })

  it("does not match the schedule being updated against itself", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend.mockResolvedValue({})
    dynamoSend
      .mockResolvedValueOnce({ Items: [scheduleRecord()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: scheduleRecord() })
      .mockResolvedValueOnce(OWNER_ROW_RESPONSE)
    schedulerSend.mockResolvedValue({})

    await expect(
      service.update(OWNER, {
        scheduleId: SCHEDULE_ID,
        prompt: "Summarize my day and my calendar",
      }),
    ).resolves.toMatchObject({ prompt: "Summarize my day and my calendar" })
  })
}

describe("AgentScheduleService name collision mapping", defineNameCollisionMappingSuite)
describe("AgentScheduleService duplicate refusal bypasses", defineDuplicateBypassSuite)
describe(
  "AgentScheduleService cancellation reasons",
  defineCancellationReasonSuite,
)
describe("AgentScheduleService likely-duplicate refusal", defineLikelyDuplicateSuite)

describe("schedules echo back what was actually saved", () => {
  it("includes the scheduler expression, description and next runs on list", async () => {
    // #1888: responses carried only the raw cronExpression, so an agent could
    // confirm a schedule by repeating the string it had just sent. These three
    // fields are the only place the stored meaning can be seen to differ.
    const { service, dynamoSend } = harness()
    dynamoSend.mockResolvedValueOnce({ Items: [scheduleRecord()] })

    const [schedule] = await service.list(OWNER)

    expect(schedule.schedulerExpression).toBe("cron(0 8 * * ? *)")
    expect(schedule.description).toBe("At 8:00 AM, every day")
    expect(schedule.nextRuns).toHaveLength(3)
    for (const run of schedule.nextRuns) {
      expect(run).toMatch(/T08:00:00[-+]\d{2}:\d{2}$/)
    }
  })

  it("reports no fire times for a disabled schedule", async () => {
    // EventBridge holds a disabled schedule, so upcoming times would promise
    // executions that never happen — in the field SKILL.md tells the agent to
    // confirm the schedule from. The description still reads back the meaning.
    const { service, dynamoSend } = harness()
    dynamoSend.mockResolvedValueOnce({
      Items: [scheduleRecord({ enabled: false })],
    })

    const [schedule] = await service.list(OWNER)

    expect(schedule.enabled).toBe(false)
    expect(schedule.description).toBe("At 8:00 AM, every day")
    expect(schedule.nextRuns).toEqual([])
  })

  it("describes a legacy numeric day-of-week the way EventBridge reads it", async () => {
    // 1-5 is SUN-THU here, not MON-FRI. The description is what makes that
    // visible to an owner who never saw the expression.
    const { service, dynamoSend } = harness()
    dynamoSend.mockResolvedValueOnce({
      Items: [
        scheduleRecord({
          cronExpression: "30 6 * * 1-5",
          schedulerExpression: "cron(30 6 ? * 1-5 *)",
        }),
      ],
    })

    const [schedule] = await service.list(OWNER)
    expect(schedule.description).toBe("At 6:30 AM, on Sunday through Thursday")
  })

  it("still describes a degraded row, using its cron when no scheduler expression was stored", async () => {
    const legacyId = "a273413f-7a93-4e43-9b49-1bc8880be024"
    const { service, dynamoSend } = harness()
    dynamoSend.mockResolvedValueOnce({
      Items: [
        {
          userId: OWNER,
          scheduleId: legacyId,
          name: "Legacy dispatch",
          prompt: "Generate it",
          cronExpression: "cron(0 6 ? * MON-FRI *)",
          timezone: "America/Los_Angeles",
          enabled: true,
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        },
      ],
    })

    const [schedule] = await service.list(OWNER)
    expect(schedule.degraded).toBe(true)
    expect(schedule.schedulerExpression).toBe("cron(0 6 ? * MON-FRI *)")
    expect(schedule.description).toBe("At 6:00 AM, on Monday through Friday")
    expect(schedule.nextRuns).toHaveLength(3)
  })

  it("reports no fire times for a disabled degraded row either", async () => {
    const legacyId = "a273413f-7a93-4e43-9b49-1bc8880be024"
    const { service, dynamoSend } = harness()
    dynamoSend.mockResolvedValueOnce({
      Items: [
        {
          userId: OWNER,
          scheduleId: legacyId,
          name: "Legacy dispatch",
          prompt: "Generate it",
          cronExpression: "cron(0 6 ? * MON-FRI *)",
          timezone: "America/Los_Angeles",
          enabled: false,
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        },
      ],
    })

    const [schedule] = await service.list(OWNER)
    expect(schedule.enabled).toBe(false)
    expect(schedule.description).toBe("At 6:00 AM, on Monday through Friday")
    expect(schedule.nextRuns).toEqual([])
  })
})
