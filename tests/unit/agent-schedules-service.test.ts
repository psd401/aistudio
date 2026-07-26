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
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb"
import {
  AgentScheduleService,
  type AgentScheduleDynamoClient,
  type AgentScheduleRecord,
} from "@/lib/agent-schedules/service"
import {
  AgentScheduleInputError,
  toSchedulerExpression,
} from "@/lib/agent-schedules/validation"

const OWNER = "owner@psd401.net"
const SCHEDULE_ID = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"

const config = {
  region: "us-east-1",
  environment: "dev",
  schedulesTable: "schedules",
  usersTable: "users",
  scheduleGroup: "psd-agent-dev",
  cronLambdaArn: "arn:aws:lambda:us-east-1:123:function:cron",
  schedulerRoleArn: "arn:aws:iam::123:role/scheduler",
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

function harness() {
  const dynamoSend = jest.fn()
  const schedulerSend = jest.fn()
  const service = new AgentScheduleService(
    config,
    { send: dynamoSend } as unknown as AgentScheduleDynamoClient,
    { send: schedulerSend } as unknown as SchedulerClient
  )
  return { service, dynamoSend, schedulerSend }
}

describe("AgentScheduleService authority boundary", () => {
  it("creates a target containing only owner, schedule id, and version", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [] })
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
    })
    expect(target?.Input).not.toContain("prompt")
    expect(target?.Input).not.toContain("dmSpaceName")

    const putCommand = dynamoSend.mock.calls[2][0]
    expect(putCommand).toBeInstanceOf(PutCommand)
    expect((putCommand as PutCommand).input.Item).toMatchObject({
      ownerEmail: OWNER,
      userId: OWNER,
      dmSpaceName: "spaces/trusted-owner-dm",
      googleIdentity: "users/12345",
    })
    expect(created).not.toHaveProperty("ownerEmail")
    expect(created).not.toHaveProperty("dmSpaceName")
  })

  it("refreshes destination from the trusted owner row and versions updates", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
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
    })
    const putCommand = dynamoSend.mock.calls[2][0] as PutCommand
    expect(putCommand.input.Item).toMatchObject({
      dmSpaceName: "spaces/new-trusted-dm",
      googleIdentity: "users/67890",
      version: 2,
    })
  })

  it("rolls back EventBridge when authoritative persistence fails", async () => {
    const { service, dynamoSend, schedulerSend } = harness()
    dynamoSend
      .mockResolvedValueOnce({ Items: [] })
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

  it("rejects records whose stored owner does not match the signed owner", async () => {
    const { service, dynamoSend } = harness()
    dynamoSend.mockResolvedValueOnce({
      Item: scheduleRecord({
        ownerEmail: "victim@psd401.net",
        userId: "victim@psd401.net",
      }),
    })
    await expect(
      service.update(OWNER, {
        scheduleId: SCHEDULE_ID,
        prompt: "attacker prompt",
      })
    ).rejects.toThrow("owner or integrity")
    expect(dynamoSend.mock.calls[0][0]).toBeInstanceOf(GetCommand)
  })
})

describe("schedule expression resource guards", () => {
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
})
