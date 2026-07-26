import { randomUUID } from "node:crypto"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import {
  DeleteCommand,
  type DeleteCommandOutput,
  DynamoDBDocumentClient,
  GetCommand,
  type GetCommandOutput,
  PutCommand,
  type PutCommandOutput,
  QueryCommand,
  type QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb"
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler"
import {
  AgentScheduleInputError,
  parseEnabled,
  toSchedulerExpression,
  validateScheduleId,
  validateScheduleName,
  validateSchedulePrompt,
  validateScheduleTimezone,
} from "@/lib/agent-schedules/validation"

const DEFAULT_TIMEZONE = "America/Los_Angeles"
const DEFAULT_MAX_SCHEDULES_PER_OWNER = 50
const GOOGLE_IDENTITY_RE = /^users\/\d+$/
const DM_SPACE_RE = /^spaces\/[\w-]{1,256}$/

export interface AgentScheduleRecord {
  userId: string
  ownerEmail: string
  scheduleId: string
  version: number
  name: string
  prompt: string
  cronExpression: string
  schedulerExpression: string
  timezone: string
  enabled: boolean
  googleIdentity?: string
  dmSpaceName: string
  displayName?: string
  workspacePrefix: string
  createdAt: string
  updatedAt: string
}

export type PublicAgentSchedule = Pick<
  AgentScheduleRecord,
  | "scheduleId"
  | "version"
  | "name"
  | "prompt"
  | "cronExpression"
  | "timezone"
  | "enabled"
  | "createdAt"
  | "updatedAt"
>

export interface CreateAgentScheduleInput {
  name: unknown
  prompt: unknown
  cron: unknown
  timezone?: unknown
  disabled?: unknown
}

export interface UpdateAgentScheduleInput {
  scheduleId: unknown
  name?: unknown
  prompt?: unknown
  cron?: unknown
  timezone?: unknown
  enabled?: unknown
}

interface TrustedOwnerProfile {
  googleIdentity?: string
  dmSpaceName: string
  displayName?: string
  workspacePrefix: string
}

export interface AgentScheduleDynamoClient {
  send(command: QueryCommand): Promise<QueryCommandOutput>
  send(command: GetCommand): Promise<GetCommandOutput>
  send(command: PutCommand): Promise<PutCommandOutput>
  send(command: DeleteCommand): Promise<DeleteCommandOutput>
}

export interface AgentScheduleServiceConfig {
  region: string
  environment: string
  schedulesTable: string
  usersTable: string
  scheduleGroup: string
  cronLambdaArn: string
  schedulerRoleArn: string
  maxSchedulesPerOwner: number
}

export class AgentScheduleNotFoundError extends Error {
  constructor() {
    super("Schedule not found")
    this.name = "AgentScheduleNotFoundError"
  }
}

export class AgentScheduleConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentScheduleConflictError"
  }
}

export class AgentScheduleQuotaError extends Error {
  constructor(maximum: number) {
    super(`Schedule quota exceeded (maximum ${maximum})`)
    this.name = "AgentScheduleQuotaError"
  }
}

export class AgentScheduleUserNotReadyError extends Error {
  constructor() {
    super("Owner must first open a direct message with the agent")
    this.name = "AgentScheduleUserNotReadyError"
  }
}

export class AgentScheduleNotConfiguredError extends Error {
  constructor() {
    super("Agent schedule broker is not configured")
    this.name = "AgentScheduleNotConfiguredError"
  }
}

export class AgentScheduleSyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentScheduleSyncError"
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function normalizeOwnerEmail(ownerEmail: string): string {
  return ownerEmail.trim().toLowerCase()
}

function publicSchedule(record: AgentScheduleRecord): PublicAgentSchedule {
  return {
    scheduleId: record.scheduleId,
    version: record.version,
    name: record.name,
    prompt: record.prompt,
    cronExpression: record.cronExpression,
    timezone: record.timezone,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function parseRecord(
  value: unknown,
  ownerEmail: string,
  scheduleId?: string
): AgentScheduleRecord {
  if (!isObject(value)) throw new AgentScheduleNotFoundError()
  const normalizedOwner = normalizeOwnerEmail(ownerEmail)
  const recordOwner =
    typeof value.ownerEmail === "string"
      ? normalizeOwnerEmail(value.ownerEmail)
      : typeof value.userId === "string"
        ? normalizeOwnerEmail(value.userId)
        : ""
  if (
    recordOwner !== normalizedOwner ||
    value.userId !== normalizedOwner ||
    typeof value.scheduleId !== "string" ||
    (scheduleId && value.scheduleId !== scheduleId) ||
    !Number.isInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.name !== "string" ||
    typeof value.prompt !== "string" ||
    typeof value.cronExpression !== "string" ||
    typeof value.schedulerExpression !== "string" ||
    typeof value.timezone !== "string" ||
    typeof value.enabled !== "boolean" ||
    typeof value.dmSpaceName !== "string" ||
    !DM_SPACE_RE.test(value.dmSpaceName) ||
    typeof value.workspacePrefix !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new AgentScheduleConflictError(
      "Schedule record failed owner or integrity validation"
    )
  }
  return value as unknown as AgentScheduleRecord
}

function parseDisabled(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value !== "boolean") {
    throw new AgentScheduleInputError("disabled must be a boolean")
  }
  return value
}

export class AgentScheduleService {
  constructor(
    private readonly config: AgentScheduleServiceConfig,
    private readonly dynamo: AgentScheduleDynamoClient,
    private readonly scheduler: SchedulerClient
  ) {}

  private scheduleName(scheduleId: string): string {
    return `${this.config.scheduleGroup}-${scheduleId}`.slice(0, 64)
  }

  private targetInput(
    ownerEmail: string,
    scheduleId: string,
    version: number
  ): string {
    return JSON.stringify({ ownerEmail, scheduleId, version })
  }

  private async trustedOwnerProfile(
    ownerEmail: string
  ): Promise<TrustedOwnerProfile> {
    const response = await this.dynamo.send(
      new QueryCommand({
        TableName: this.config.usersTable,
        IndexName: "email-index",
        KeyConditionExpression: "email = :email",
        ExpressionAttributeValues: { ":email": ownerEmail },
      })
    )
    const candidates = (response.Items ?? []).filter((item) => {
      if (!isObject(item)) return false
      return (
        typeof item.email === "string" &&
        normalizeOwnerEmail(item.email) === ownerEmail &&
        typeof item.dmSpaceName === "string" &&
        DM_SPACE_RE.test(item.dmSpaceName)
      )
    })
    const selected =
      candidates.find(
        (item) =>
          typeof item.googleIdentity === "string" &&
          GOOGLE_IDENTITY_RE.test(item.googleIdentity)
      ) ?? candidates[0]
    if (!selected || typeof selected.dmSpaceName !== "string") {
      throw new AgentScheduleUserNotReadyError()
    }
    const workspacePrefix =
      typeof selected.workspacePrefix === "string" &&
      selected.workspacePrefix.length > 0 &&
      selected.workspacePrefix.length <= 128
        ? selected.workspacePrefix
        : ownerEmail.split("@")[0]
    return {
      googleIdentity:
        typeof selected.googleIdentity === "string" &&
        GOOGLE_IDENTITY_RE.test(selected.googleIdentity)
          ? selected.googleIdentity
          : undefined,
      dmSpaceName: selected.dmSpaceName,
      displayName:
        typeof selected.displayName === "string" &&
        selected.displayName.length <= 200
          ? selected.displayName
          : undefined,
      workspacePrefix,
    }
  }

  private async getRecord(
    ownerEmail: string,
    scheduleId: string
  ): Promise<AgentScheduleRecord> {
    const response = await this.dynamo.send(
      new GetCommand({
        TableName: this.config.schedulesTable,
        Key: { userId: ownerEmail, scheduleId },
        ConsistentRead: true,
      })
    )
    return parseRecord(response.Item, ownerEmail, scheduleId)
  }

  async list(owner: string): Promise<PublicAgentSchedule[]> {
    const ownerEmail = normalizeOwnerEmail(owner)
    const response = await this.dynamo.send(
      new QueryCommand({
        TableName: this.config.schedulesTable,
        KeyConditionExpression: "userId = :owner",
        ExpressionAttributeValues: { ":owner": ownerEmail },
        ConsistentRead: true,
      })
    )
    return (response.Items ?? [])
      .map((item) => parseRecord(item, ownerEmail))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(publicSchedule)
  }

  async create(
    owner: string,
    input: CreateAgentScheduleInput
  ): Promise<PublicAgentSchedule> {
    const ownerEmail = normalizeOwnerEmail(owner)
    const name = validateScheduleName(input.name)
    const prompt = validateSchedulePrompt(input.prompt)
    const cronExpression =
      typeof input.cron === "string" ? input.cron.trim() : input.cron
    const schedulerExpression = toSchedulerExpression(cronExpression)
    const timezone = validateScheduleTimezone(
      input.timezone ?? DEFAULT_TIMEZONE
    )
    const enabled = !parseDisabled(input.disabled)
    const existing = await this.list(ownerEmail)
    if (existing.length >= this.config.maxSchedulesPerOwner) {
      throw new AgentScheduleQuotaError(this.config.maxSchedulesPerOwner)
    }
    if (existing.some((schedule) => schedule.name === name)) {
      throw new AgentScheduleConflictError(
        "A schedule with this name already exists"
      )
    }

    const profile = await this.trustedOwnerProfile(ownerEmail)
    const scheduleId = randomUUID()
    const version = 1
    const now = new Date().toISOString()
    const record: AgentScheduleRecord = {
      userId: ownerEmail,
      ownerEmail,
      scheduleId,
      version,
      name,
      prompt,
      cronExpression: String(cronExpression),
      schedulerExpression,
      timezone,
      enabled,
      ...profile,
      createdAt: now,
      updatedAt: now,
    }
    const schedulerName = this.scheduleName(scheduleId)
    await this.scheduler.send(
      new CreateScheduleCommand({
        Name: schedulerName,
        GroupName: this.config.scheduleGroup,
        ScheduleExpression: schedulerExpression,
        ScheduleExpressionTimezone: timezone,
        FlexibleTimeWindow: { Mode: "OFF" },
        State: enabled ? "ENABLED" : "DISABLED",
        ActionAfterCompletion: schedulerExpression.startsWith("at(")
          ? "DELETE"
          : "NONE",
        Target: {
          Arn: this.config.cronLambdaArn,
          RoleArn: this.config.schedulerRoleArn,
          Input: this.targetInput(ownerEmail, scheduleId, version),
        },
        Description: `PSD agent schedule ${scheduleId}`,
      })
    )
    try {
      await this.dynamo.send(
        new PutCommand({
          TableName: this.config.schedulesTable,
          Item: record,
          ConditionExpression:
            "attribute_not_exists(userId) AND attribute_not_exists(scheduleId)",
        })
      )
    } catch (error) {
      try {
        await this.scheduler.send(
          new DeleteScheduleCommand({
            Name: schedulerName,
            GroupName: this.config.scheduleGroup,
          })
        )
      } catch {
        throw new AgentScheduleSyncError(
          "Schedule persistence failed and scheduler rollback also failed"
        )
      }
      throw error
    }
    return publicSchedule(record)
  }

  async update(
    owner: string,
    input: UpdateAgentScheduleInput
  ): Promise<PublicAgentSchedule> {
    const ownerEmail = normalizeOwnerEmail(owner)
    const scheduleId = validateScheduleId(input.scheduleId)
    const current = await this.getRecord(ownerEmail, scheduleId)
    if (
      input.name === undefined &&
      input.prompt === undefined &&
      input.cron === undefined &&
      input.timezone === undefined &&
      input.enabled === undefined
    ) {
      throw new AgentScheduleInputError("At least one update is required")
    }
    const name =
      input.name === undefined ? current.name : validateScheduleName(input.name)
    const prompt =
      input.prompt === undefined
        ? current.prompt
        : validateSchedulePrompt(input.prompt)
    const cronExpression =
      input.cron === undefined
        ? current.cronExpression
        : typeof input.cron === "string"
          ? input.cron.trim()
          : input.cron
    const schedulerExpression =
      input.cron === undefined
        ? current.schedulerExpression
        : toSchedulerExpression(cronExpression)
    const timezone =
      input.timezone === undefined
        ? current.timezone
        : validateScheduleTimezone(input.timezone)
    const enabled =
      input.enabled === undefined ? current.enabled : parseEnabled(input.enabled)
    const profile = await this.trustedOwnerProfile(ownerEmail)
    const updated: AgentScheduleRecord = {
      ...current,
      ...profile,
      version: current.version + 1,
      name,
      prompt,
      cronExpression: String(cronExpression),
      schedulerExpression,
      timezone,
      enabled,
      updatedAt: new Date().toISOString(),
    }
    await this.dynamo.send(
      new PutCommand({
        TableName: this.config.schedulesTable,
        Item: updated,
        ConditionExpression:
          "attribute_exists(userId) AND attribute_exists(scheduleId) AND #version = :version",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":version": current.version },
      })
    )
    try {
      await this.scheduler.send(
        new UpdateScheduleCommand({
          Name: this.scheduleName(scheduleId),
          GroupName: this.config.scheduleGroup,
          ScheduleExpression: schedulerExpression,
          ScheduleExpressionTimezone: timezone,
          FlexibleTimeWindow: { Mode: "OFF" },
          State: enabled ? "ENABLED" : "DISABLED",
          ActionAfterCompletion: schedulerExpression.startsWith("at(")
            ? "DELETE"
            : "NONE",
          Target: {
            Arn: this.config.cronLambdaArn,
            RoleArn: this.config.schedulerRoleArn,
            Input: this.targetInput(ownerEmail, scheduleId, updated.version),
          },
          Description: `PSD agent schedule ${scheduleId}`,
        })
      )
    } catch {
      throw new AgentScheduleSyncError(
        "Schedule was saved but the scheduler is stale; retry the update"
      )
    }
    return publicSchedule(updated)
  }

  async delete(owner: string, rawScheduleId: unknown): Promise<string> {
    const ownerEmail = normalizeOwnerEmail(owner)
    const scheduleId = validateScheduleId(rawScheduleId)
    const current = await this.getRecord(ownerEmail, scheduleId)
    try {
      await this.scheduler.send(
        new DeleteScheduleCommand({
          Name: this.scheduleName(scheduleId),
          GroupName: this.config.scheduleGroup,
        })
      )
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error
    }
    await this.dynamo.send(
      new DeleteCommand({
        TableName: this.config.schedulesTable,
        Key: { userId: ownerEmail, scheduleId },
        ConditionExpression: "#version = :version",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":version": current.version },
      })
    )
    return scheduleId
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new AgentScheduleNotConfiguredError()
  return value
}

export function createAgentScheduleService(): AgentScheduleService {
  const region = process.env.AWS_REGION || "us-east-1"
  const maximum = Number.parseInt(
    process.env.MAX_SCHEDULES_PER_USER ||
      String(DEFAULT_MAX_SCHEDULES_PER_OWNER),
    10
  )
  const config: AgentScheduleServiceConfig = {
    region,
    environment: process.env.ENVIRONMENT || "dev",
    schedulesTable: requiredEnvironment("AGENT_SCHEDULES_TABLE"),
    usersTable: requiredEnvironment("AGENT_USERS_TABLE"),
    scheduleGroup: requiredEnvironment("AGENT_SCHEDULE_GROUP"),
    cronLambdaArn: requiredEnvironment("AGENT_CRON_LAMBDA_ARN"),
    schedulerRoleArn: requiredEnvironment("AGENT_SCHEDULER_ROLE_ARN"),
    maxSchedulesPerOwner:
      Number.isInteger(maximum) && maximum > 0
        ? maximum
        : DEFAULT_MAX_SCHEDULES_PER_OWNER,
  }
  return new AgentScheduleService(
    config,
    DynamoDBDocumentClient.from(
      new DynamoDBClient({ region })
    ) as unknown as AgentScheduleDynamoClient,
    new SchedulerClient({ region })
  )
}
