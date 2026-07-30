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
  AgentScheduleService,
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
  const service = new AgentScheduleService(
    config,
    { send: dynamoSend } as unknown as AgentScheduleDynamoClient,
    { send: schedulerSend } as unknown as SchedulerClient,
    { latestBySchedule } as AgentScheduleRunReader,
  )
  return { service, dynamoSend, schedulerSend, latestBySchedule }
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
