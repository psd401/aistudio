import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
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
  TransactWriteCommand,
  type TransactWriteCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import {
  AgentScheduleInputError,
  parseEnabled,
  toSchedulerExpression,
  validateScheduleId,
  validateScheduleName,
  validateSchedulePrompt,
  validateScheduleTimezone,
} from "@/lib/agent-schedules/validation";
import {
  DrizzleAgentScheduleRunReader,
  type AgentScheduleLastRun,
  type AgentScheduleRunReader,
} from "@/lib/agent-schedules/run-reader";
import { createLogger } from "@/lib/logger";

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_MAX_SCHEDULES_PER_OWNER = 50;
const LAST_RUN_ERROR_MAX_LENGTH = 500;
const SCHEDULE_MAXIMUM_EVENT_AGE_SECONDS = 60 * 60;
const SCHEDULE_MAXIMUM_RETRY_ATTEMPTS = 2;
const GOOGLE_IDENTITY_RE = /^users\/\d+$/;
const DM_SPACE_RE = /^spaces\/[\w-]{1,256}$/;
const log = createLogger({ module: "agent-schedules-service" });
type ScheduleTransactItems = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]
>;

export interface AgentScheduleRecord {
  userId: string;
  ownerEmail: string;
  scheduleId: string;
  version: number;
  name: string;
  prompt: string;
  cronExpression: string;
  schedulerExpression: string;
  timezone: string;
  enabled: boolean;
  googleIdentity?: string;
  dmSpaceName: string;
  displayName?: string;
  workspacePrefix: string;
  createdAt: string;
  updatedAt: string;
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
> & {
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
};

export interface CreateAgentScheduleInput {
  name: unknown;
  prompt: unknown;
  cron: unknown;
  timezone?: unknown;
  disabled?: unknown;
}

export interface UpdateAgentScheduleInput {
  scheduleId: unknown;
  name?: unknown;
  prompt?: unknown;
  cron?: unknown;
  timezone?: unknown;
  enabled?: unknown;
}

function hasScheduleUpdates(input: UpdateAgentScheduleInput): boolean {
  return [
    input.name,
    input.prompt,
    input.cron,
    input.timezone,
    input.enabled,
  ].some((value) => value !== undefined);
}

function resolvedScheduleFields(
  current: AgentScheduleRecord,
  input: UpdateAgentScheduleInput,
): Pick<
  AgentScheduleRecord,
  | "name"
  | "prompt"
  | "cronExpression"
  | "schedulerExpression"
  | "timezone"
  | "enabled"
> {
  if (!hasScheduleUpdates(input)) {
    throw new AgentScheduleInputError("At least one update is required");
  }
  const cronExpression =
    input.cron === undefined
      ? current.cronExpression
      : typeof input.cron === "string"
        ? input.cron.trim()
        : input.cron;
  return {
    name:
      input.name === undefined
        ? current.name
        : validateScheduleName(input.name),
    prompt:
      input.prompt === undefined
        ? current.prompt
        : validateSchedulePrompt(input.prompt),
    cronExpression: String(cronExpression),
    schedulerExpression:
      input.cron === undefined
        ? current.schedulerExpression
        : toSchedulerExpression(cronExpression),
    timezone:
      input.timezone === undefined
        ? current.timezone
        : validateScheduleTimezone(input.timezone),
    enabled:
      input.enabled === undefined
        ? current.enabled
        : parseEnabled(input.enabled),
  };
}

interface TrustedOwnerProfile {
  googleIdentity?: string;
  dmSpaceName: string;
  displayName?: string;
  workspacePrefix: string;
}

export interface AgentScheduleDynamoClient {
  send(command: QueryCommand): Promise<QueryCommandOutput>;
  send(command: GetCommand): Promise<GetCommandOutput>;
  send(command: PutCommand): Promise<PutCommandOutput>;
  send(command: DeleteCommand): Promise<DeleteCommandOutput>;
  send(command: TransactWriteCommand): Promise<TransactWriteCommandOutput>;
}

export interface AgentScheduleServiceConfig {
  region: string;
  environment: string;
  schedulesTable: string;
  usersTable: string;
  scheduleGroup: string;
  cronLambdaArn: string;
  schedulerRoleArn: string;
  scheduleDlqArn: string;
  maxSchedulesPerOwner: number;
}

export class AgentScheduleNotFoundError extends Error {
  constructor() {
    super("Schedule not found");
    this.name = "AgentScheduleNotFoundError";
  }
}

export class AgentScheduleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentScheduleConflictError";
  }
}

export class AgentScheduleQuotaError extends Error {
  constructor(maximum: number) {
    super(`Schedule quota exceeded (maximum ${maximum})`);
    this.name = "AgentScheduleQuotaError";
  }
}

export class AgentScheduleUserNotReadyError extends Error {
  constructor() {
    super("Owner must first open a direct message with the agent");
    this.name = "AgentScheduleUserNotReadyError";
  }
}

export class AgentScheduleNotConfiguredError extends Error {
  constructor() {
    super("Agent schedule broker is not configured");
    this.name = "AgentScheduleNotConfiguredError";
  }
}

export class AgentScheduleSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentScheduleSyncError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function normalizeOwnerEmail(ownerEmail: string): string {
  return ownerEmail.trim().toLowerCase();
}

export function scheduleTransactionToken(
  operation: "create" | "update" | "delete" | "reconcile",
  scheduleId: string,
  version?: number,
): string {
  return createHash("sha256")
    .update(`${operation}:${scheduleId}:${version ?? ""}`)
    .digest("hex")
    .slice(0, 36);
}

function publicSchedule(
  record: AgentScheduleRecord,
  lastRun?: AgentScheduleLastRun,
  runEnrichmentAvailable = true,
): PublicAgentSchedule {
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
    lastRunAt: lastRun?.createdAt.toISOString() ?? null,
    lastRunStatus: runEnrichmentAvailable
      ? lastRun?.status ?? null
      : "unknown",
    lastRunError: lastRun?.errorMessage
      ? lastRun.errorMessage.slice(0, LAST_RUN_ERROR_MAX_LENGTH)
      : null,
  };
}

function parseRecord(
  value: unknown,
  ownerEmail: string,
  scheduleId?: string,
): AgentScheduleRecord {
  if (!isObject(value)) throw new AgentScheduleNotFoundError();
  const normalizedOwner = normalizeOwnerEmail(ownerEmail);
  if (!hasValidScheduleOwner(value, normalizedOwner, scheduleId)) {
    throw new AgentScheduleConflictError(
      "Schedule record failed owner or integrity validation",
    );
  }
  if (!hasValidScheduleDefinition(value) || !hasValidScheduleMetadata(value)) {
    throw new AgentScheduleConflictError(
      "Schedule record failed owner or integrity validation",
    );
  }
  return value as unknown as AgentScheduleRecord;
}

function hasValidScheduleOwner(
  value: Record<string, unknown>,
  normalizedOwner: string,
  scheduleId?: string,
): boolean {
  const recordOwner =
    typeof value.ownerEmail === "string"
      ? normalizeOwnerEmail(value.ownerEmail)
      : typeof value.userId === "string"
        ? normalizeOwnerEmail(value.userId)
        : "";
  return (
    recordOwner === normalizedOwner &&
    value.userId === normalizedOwner &&
    typeof value.scheduleId === "string" &&
    (!scheduleId || value.scheduleId === scheduleId)
  );
}

function hasValidScheduleDefinition(value: Record<string, unknown>): boolean {
  return (
    Number.isInteger(value.version) &&
    Number(value.version) >= 1 &&
    typeof value.name === "string" &&
    typeof value.prompt === "string" &&
    typeof value.cronExpression === "string" &&
    typeof value.schedulerExpression === "string" &&
    typeof value.timezone === "string" &&
    typeof value.enabled === "boolean"
  );
}

function hasValidScheduleMetadata(value: Record<string, unknown>): boolean {
  return (
    typeof value.dmSpaceName === "string" &&
    DM_SPACE_RE.test(value.dmSpaceName) &&
    typeof value.workspacePrefix === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function ownerMetadataSnapshot(
  items: Record<string, unknown>[],
  ownerEmail: string,
): {
  records: AgentScheduleRecord[];
  quota?: Record<string, unknown>;
  guards: Map<string, Record<string, unknown>>;
} {
  const records = items
    .filter(
      (item) =>
        typeof item.scheduleId === "string" &&
        !item.scheduleId.startsWith("__"),
    )
    .map((item) => parseRecord(item, ownerEmail));
  const quota = items.find((item) => item.scheduleId === "__quota__");
  const guards = new Map(
    items
      .filter(
        (item) =>
          typeof item.scheduleId === "string" &&
          item.scheduleId.startsWith("__name__"),
      )
      .map((item) => [item.scheduleId as string, item]),
  );
  return { records, quota, guards };
}

function quotaConditionExpression(
  alreadyReconciled: boolean,
  previousCount: number | null,
): string {
  if (!alreadyReconciled) {
    return "attribute_not_exists(reconciled) OR reconciled <> :true";
  }
  return previousCount === null
    ? "reconciled = :true AND attribute_not_exists(activeCount)"
    : "reconciled = :true AND activeCount = :previous";
}

function planStaleGuardDeletes(
  schedulesTable: string,
  ownerEmail: string,
  guards: Map<string, Record<string, unknown>>,
  plannedGuards: Map<string, string>,
): ScheduleTransactItems {
  const items: ScheduleTransactItems = [];
  for (const [guardId, guard] of guards) {
    if (plannedGuards.has(guardId)) continue;
    const previousTarget = guard.targetScheduleId;
    items.push({
      Delete: {
        TableName: schedulesTable,
        Key: { userId: ownerEmail, scheduleId: guardId },
        ...(typeof previousTarget === "string"
          ? {
              ConditionExpression: "targetScheduleId = :previous",
              ExpressionAttributeValues: { ":previous": previousTarget },
            }
          : {}),
      },
    });
  }
  return items;
}

function parseDisabled(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new AgentScheduleInputError("disabled must be a boolean");
  }
  return value;
}

export class AgentScheduleService {
  constructor(
    private readonly config: AgentScheduleServiceConfig,
    private readonly dynamo: AgentScheduleDynamoClient,
    private readonly scheduler: SchedulerClient,
    private readonly runReader: AgentScheduleRunReader,
  ) {}

  private scheduleName(scheduleId: string): string {
    return `${this.config.scheduleGroup}-${scheduleId}`.slice(0, 64);
  }

  private ownerQuotaKey(ownerEmail: string): {
    userId: string;
    scheduleId: string;
  } {
    return { userId: ownerEmail, scheduleId: "__quota__" };
  }

  private ownerNameKey(
    ownerEmail: string,
    name: string,
  ): {
    userId: string;
    scheduleId: string;
  } {
    const digest = createHash("sha256")
      .update(name.trim().toLowerCase())
      .digest("hex")
      .slice(0, 32);
    return { userId: ownerEmail, scheduleId: `__name__${digest}` };
  }

  private targetInput(
    ownerEmail: string,
    scheduleId: string,
    version: number,
  ): string {
    return JSON.stringify({
      ownerEmail,
      scheduleId,
      version,
      scheduledTime: "<aws.scheduler.scheduled-time>",
    });
  }

  private async trustedOwnerProfile(
    ownerEmail: string,
  ): Promise<TrustedOwnerProfile> {
    const response = await this.dynamo.send(
      new QueryCommand({
        TableName: this.config.usersTable,
        IndexName: "email-index",
        KeyConditionExpression: "email = :email",
        ExpressionAttributeValues: { ":email": ownerEmail },
      }),
    );
    const candidates = (response.Items ?? []).filter((item) => {
      if (!isObject(item)) return false;
      return (
        typeof item.email === "string" &&
        normalizeOwnerEmail(item.email) === ownerEmail &&
        typeof item.dmSpaceName === "string" &&
        DM_SPACE_RE.test(item.dmSpaceName)
      );
    });
    const selected =
      candidates.find(
        (item) =>
          typeof item.googleIdentity === "string" &&
          GOOGLE_IDENTITY_RE.test(item.googleIdentity),
      ) ?? candidates[0];
    if (!selected || typeof selected.dmSpaceName !== "string") {
      throw new AgentScheduleUserNotReadyError();
    }
    const workspacePrefix =
      typeof selected.workspacePrefix === "string" &&
      selected.workspacePrefix.length > 0 &&
      selected.workspacePrefix.length <= 128
        ? selected.workspacePrefix
        : ownerEmail.split("@")[0];
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
    };
  }

  private async getRecord(
    ownerEmail: string,
    scheduleId: string,
  ): Promise<AgentScheduleRecord> {
    const response = await this.dynamo.send(
      new GetCommand({
        TableName: this.config.schedulesTable,
        Key: { userId: ownerEmail, scheduleId },
        ConsistentRead: true,
      }),
    );
    return parseRecord(response.Item, ownerEmail, scheduleId);
  }

  private async ownerItems(
    ownerEmail: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.dynamo.send(
        new QueryCommand({
          TableName: this.config.schedulesTable,
          KeyConditionExpression: "userId = :owner",
          ExpressionAttributeValues: { ":owner": ownerEmail },
          ConsistentRead: true,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(
        ...(response.Items ?? []).filter(
          (item): item is Record<string, unknown> =>
            isObject(item) && typeof item.scheduleId === "string",
        ),
      );
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  /**
   * Backfill quota/name metadata for owners whose schedules predate the
   * transactional admission scheme. New mutations require the reconciled
   * marker, so concurrent creates cannot increment an unseeded zero counter.
   */
  private async ensureOwnerMetadata(ownerEmail: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const items = await this.ownerItems(ownerEmail);
      const { records, quota, guards } = ownerMetadataSnapshot(items, ownerEmail);
      const transactItems = [
        ...this.planQuotaReconciliation(ownerEmail, records.length, quota),
        ...this.planNameGuardReconciliation(ownerEmail, records, guards),
      ];
      if (transactItems.length === 0) return;
      try {
        await this.dynamo.send(
          new TransactWriteCommand({
            ClientRequestToken: scheduleTransactionToken(
              "reconcile",
              ownerEmail,
              attempt,
            ),
            TransactItems: transactItems,
          }),
        );
        return;
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "TransactionCanceledException" &&
          attempt < 2
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  private planQuotaReconciliation(
    ownerEmail: string,
    activeCount: number,
    quota?: Record<string, unknown>,
  ): ScheduleTransactItems {
    const previousCount =
      typeof quota?.activeCount === "number" &&
      Number.isSafeInteger(quota.activeCount)
        ? quota.activeCount
        : null;
    if (quota?.reconciled === true && previousCount === activeCount) return [];
    const alreadyReconciled = quota?.reconciled === true;
    return [{
      Put: {
        TableName: this.config.schedulesTable,
        Item: {
          ...this.ownerQuotaKey(ownerEmail),
          activeCount,
          reconciled: true,
        },
        ConditionExpression: quotaConditionExpression(alreadyReconciled, previousCount),
        ExpressionAttributeValues:
          alreadyReconciled && previousCount !== null
            ? { ":true": true, ":previous": previousCount }
            : { ":true": true },
      },
    }];
  }

  private planNameGuardReconciliation(
    ownerEmail: string,
    records: AgentScheduleRecord[],
    guards: Map<string, Record<string, unknown>>,
  ): ScheduleTransactItems {
    const transactItems: ScheduleTransactItems = [];
    const plannedGuards = new Map<string, string>();
    for (const record of records) {
      const key = this.ownerNameKey(ownerEmail, record.name);
      const existingTarget = plannedGuards.get(key.scheduleId);
      if (existingTarget && existingTarget !== record.scheduleId) {
        throw new AgentScheduleConflictError("Legacy schedules contain duplicate names");
      }
      plannedGuards.set(key.scheduleId, record.scheduleId);
      const item = this.planNameGuardPut(key, record, guards.get(key.scheduleId));
      if (item) transactItems.push(item);
    }
    transactItems.push(
      ...planStaleGuardDeletes(
        this.config.schedulesTable,
        ownerEmail,
        guards,
        plannedGuards,
      ),
    );
    return transactItems;
  }

  private planNameGuardPut(
    key: { userId: string; scheduleId: string },
    record: AgentScheduleRecord,
    existingGuard?: Record<string, unknown>,
  ): ScheduleTransactItems[number] | null {
    if (!existingGuard) {
      return {
        Put: {
          TableName: this.config.schedulesTable,
          Item: { ...key, targetScheduleId: record.scheduleId },
          ConditionExpression:
            "attribute_not_exists(userId) AND attribute_not_exists(scheduleId)",
        },
      };
    }
    if (existingGuard.targetScheduleId === record.scheduleId) return null;
    const previousTarget = existingGuard.targetScheduleId;
    return {
      Put: {
        TableName: this.config.schedulesTable,
        Item: { ...key, targetScheduleId: record.scheduleId },
        ConditionExpression:
          typeof previousTarget === "string"
            ? "targetScheduleId = :previous"
            : "attribute_not_exists(targetScheduleId)",
        ...(typeof previousTarget === "string"
          ? { ExpressionAttributeValues: { ":previous": previousTarget } }
          : {}),
      },
    };
  }

  async list(owner: string): Promise<PublicAgentSchedule[]> {
    const ownerEmail = normalizeOwnerEmail(owner);
    const records = (await this.ownerItems(ownerEmail))
      .filter(
        (item) =>
          typeof item.scheduleId === "string" &&
          !item.scheduleId.startsWith("__"),
      )
      .map((item) => parseRecord(item, ownerEmail))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    let lastRuns = new Map<string, AgentScheduleLastRun>();
    let runEnrichmentAvailable = true;
    try {
      lastRuns = await this.runReader.latestBySchedule(
        ownerEmail,
        records.map((record) => record.scheduleId),
      );
    } catch (error) {
      runEnrichmentAvailable = false;
      log.warn("Latest schedule run enrichment unavailable", {
        scheduleCount: records.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return records.map((record) =>
      publicSchedule(
        record,
        lastRuns.get(record.scheduleId),
        runEnrichmentAvailable,
      ),
    );
  }

  async create(
    owner: string,
    input: CreateAgentScheduleInput,
  ): Promise<PublicAgentSchedule> {
    const ownerEmail = normalizeOwnerEmail(owner);
    const name = validateScheduleName(input.name);
    const prompt = validateSchedulePrompt(input.prompt);
    const cronExpression =
      typeof input.cron === "string" ? input.cron.trim() : input.cron;
    const schedulerExpression = toSchedulerExpression(cronExpression);
    const timezone = validateScheduleTimezone(
      input.timezone ?? DEFAULT_TIMEZONE,
    );
    const enabled = !parseDisabled(input.disabled);
    await this.ensureOwnerMetadata(ownerEmail);
    const profile = await this.trustedOwnerProfile(ownerEmail);
    const scheduleId = randomUUID();
    const version = 1;
    const now = new Date().toISOString();
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
    };
    const schedulerName = this.scheduleName(scheduleId);
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
          DeadLetterConfig: { Arn: this.config.scheduleDlqArn },
          RetryPolicy: {
            MaximumEventAgeInSeconds: SCHEDULE_MAXIMUM_EVENT_AGE_SECONDS,
            MaximumRetryAttempts: SCHEDULE_MAXIMUM_RETRY_ATTEMPTS,
          },
        },
        Description: `PSD agent schedule ${scheduleId}`,
      }),
    );
    try {
      await this.dynamo.send(
        new TransactWriteCommand({
          ClientRequestToken: scheduleTransactionToken(
            "create",
            scheduleId,
            version,
          ),
          TransactItems: [
            {
              Update: {
                TableName: this.config.schedulesTable,
                Key: this.ownerQuotaKey(ownerEmail),
                UpdateExpression:
                  "SET activeCount = if_not_exists(activeCount, :zero) + :one",
                ConditionExpression:
                  "reconciled = :true AND activeCount < :maximum",
                ExpressionAttributeValues: {
                  ":zero": 0,
                  ":one": 1,
                  ":maximum": this.config.maxSchedulesPerOwner,
                  ":true": true,
                },
              },
            },
            {
              Put: {
                TableName: this.config.schedulesTable,
                Item: {
                  ...this.ownerNameKey(ownerEmail, name),
                  targetScheduleId: scheduleId,
                },
                ConditionExpression:
                  "attribute_not_exists(userId) AND attribute_not_exists(scheduleId)",
              },
            },
            {
              Put: {
                TableName: this.config.schedulesTable,
                Item: record,
                ConditionExpression:
                  "attribute_not_exists(userId) AND attribute_not_exists(scheduleId)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      try {
        await this.scheduler.send(
          new DeleteScheduleCommand({
            Name: schedulerName,
            GroupName: this.config.scheduleGroup,
          }),
        );
      } catch {
        throw new AgentScheduleSyncError(
          "Schedule persistence failed and scheduler rollback also failed",
        );
      }
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        throw new AgentScheduleQuotaError(this.config.maxSchedulesPerOwner);
      }
      throw error;
    }
    return publicSchedule(record);
  }

  async update(
    owner: string,
    input: UpdateAgentScheduleInput,
  ): Promise<PublicAgentSchedule> {
    const ownerEmail = normalizeOwnerEmail(owner);
    const scheduleId = validateScheduleId(input.scheduleId);
    await this.ensureOwnerMetadata(ownerEmail);
    const current = await this.getRecord(ownerEmail, scheduleId);
    const fields = resolvedScheduleFields(current, input);
    const profile = await this.trustedOwnerProfile(ownerEmail);
    const updated: AgentScheduleRecord = {
      ...current,
      ...profile,
      ...fields,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    if (updated.name === current.name) {
      await this.dynamo.send(
        new PutCommand({
          TableName: this.config.schedulesTable,
          Item: updated,
          ConditionExpression:
            "attribute_exists(userId) AND attribute_exists(scheduleId) AND #version = :version",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: { ":version": current.version },
        }),
      );
    } else {
      await this.dynamo.send(
        new TransactWriteCommand({
          ClientRequestToken: scheduleTransactionToken(
            "update",
            scheduleId,
            updated.version,
          ),
          TransactItems: [
            {
              Delete: {
                TableName: this.config.schedulesTable,
                Key: this.ownerNameKey(ownerEmail, current.name),
                ConditionExpression: "targetScheduleId = :scheduleId",
                ExpressionAttributeValues: { ":scheduleId": scheduleId },
              },
            },
            {
              Put: {
                TableName: this.config.schedulesTable,
                Item: {
                  ...this.ownerNameKey(ownerEmail, updated.name),
                  targetScheduleId: scheduleId,
                },
                ConditionExpression:
                  "attribute_not_exists(userId) AND attribute_not_exists(scheduleId)",
              },
            },
            {
              Put: {
                TableName: this.config.schedulesTable,
                Item: updated,
                ConditionExpression:
                  "attribute_exists(userId) AND attribute_exists(scheduleId) AND #version = :version",
                ExpressionAttributeNames: { "#version": "version" },
                ExpressionAttributeValues: { ":version": current.version },
              },
            },
          ],
        }),
      );
    }
    try {
      await this.scheduler.send(
        new UpdateScheduleCommand({
          Name: this.scheduleName(scheduleId),
          GroupName: this.config.scheduleGroup,
          ScheduleExpression: updated.schedulerExpression,
          ScheduleExpressionTimezone: updated.timezone,
          FlexibleTimeWindow: { Mode: "OFF" },
          State: updated.enabled ? "ENABLED" : "DISABLED",
          ActionAfterCompletion: updated.schedulerExpression.startsWith("at(")
            ? "DELETE"
            : "NONE",
          Target: {
            Arn: this.config.cronLambdaArn,
            RoleArn: this.config.schedulerRoleArn,
            Input: this.targetInput(ownerEmail, scheduleId, updated.version),
            DeadLetterConfig: { Arn: this.config.scheduleDlqArn },
            RetryPolicy: {
              MaximumEventAgeInSeconds: SCHEDULE_MAXIMUM_EVENT_AGE_SECONDS,
              MaximumRetryAttempts: SCHEDULE_MAXIMUM_RETRY_ATTEMPTS,
            },
          },
          Description: `PSD agent schedule ${scheduleId}`,
        }),
      );
    } catch {
      throw new AgentScheduleSyncError(
        "Schedule was saved but the scheduler is stale; retry the update",
      );
    }
    return publicSchedule(updated);
  }

  async delete(owner: string, rawScheduleId: unknown): Promise<string> {
    const ownerEmail = normalizeOwnerEmail(owner);
    const scheduleId = validateScheduleId(rawScheduleId);
    await this.ensureOwnerMetadata(ownerEmail);
    const current = await this.getRecord(ownerEmail, scheduleId);
    try {
      await this.scheduler.send(
        new DeleteScheduleCommand({
          Name: this.scheduleName(scheduleId),
          GroupName: this.config.scheduleGroup,
        }),
      );
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) {
        throw new AgentScheduleSyncError(
          "Scheduler cleanup failed; retry the delete",
        );
      }
    }
    await this.dynamo.send(
      new TransactWriteCommand({
        ClientRequestToken: scheduleTransactionToken(
          "delete",
          scheduleId,
          current.version,
        ),
        TransactItems: [
          {
            Delete: {
              TableName: this.config.schedulesTable,
              Key: { userId: ownerEmail, scheduleId },
              ConditionExpression: "#version = :version",
              ExpressionAttributeNames: { "#version": "version" },
              ExpressionAttributeValues: { ":version": current.version },
            },
          },
          {
            Delete: {
              TableName: this.config.schedulesTable,
              Key: this.ownerNameKey(ownerEmail, current.name),
            },
          },
          {
            Update: {
              TableName: this.config.schedulesTable,
              Key: this.ownerQuotaKey(ownerEmail),
              UpdateExpression: "SET activeCount = activeCount - :one",
              ConditionExpression: "activeCount >= :one",
              ExpressionAttributeValues: { ":one": 1 },
            },
          },
        ],
      }),
    );
    return scheduleId;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new AgentScheduleNotConfiguredError();
  return value;
}

export function createAgentScheduleService(): AgentScheduleService {
  const region = process.env.AWS_REGION || "us-east-1";
  const maximum = Number.parseInt(
    process.env.MAX_SCHEDULES_PER_USER ||
      String(DEFAULT_MAX_SCHEDULES_PER_OWNER),
    10,
  );
  const config: AgentScheduleServiceConfig = {
    region,
    environment: process.env.ENVIRONMENT || "dev",
    schedulesTable: requiredEnvironment("AGENT_SCHEDULES_TABLE"),
    usersTable: requiredEnvironment("AGENT_USERS_TABLE"),
    scheduleGroup: requiredEnvironment("AGENT_SCHEDULE_GROUP"),
    cronLambdaArn: requiredEnvironment("AGENT_CRON_LAMBDA_ARN"),
    schedulerRoleArn: requiredEnvironment("AGENT_SCHEDULER_ROLE_ARN"),
    scheduleDlqArn: requiredEnvironment("AGENT_SCHEDULE_DLQ_ARN"),
    maxSchedulesPerOwner:
      Number.isInteger(maximum) && maximum > 0
        ? maximum
        : DEFAULT_MAX_SCHEDULES_PER_OWNER,
  };
  return new AgentScheduleService(
    config,
    DynamoDBDocumentClient.from(
      new DynamoDBClient({ region }),
    ) as unknown as AgentScheduleDynamoClient,
    new SchedulerClient({ region }),
    new DrizzleAgentScheduleRunReader(),
  );
}
