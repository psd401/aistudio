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
  DEFAULT_SCHEDULE_TIMEZONE,
  parseEnabled,
  toSchedulerExpression,
  validateScheduleId,
  validateScheduleName,
  validateSchedulePrompt,
  validateScheduleTimezone,
} from "@/lib/agent-schedules/validation";
import { describeScheduleExpression } from "@/lib/agent-schedules/schedule-description";
import {
  DrizzleAgentScheduleRunReader,
  FAILING_SCHEDULE_THRESHOLD,
  FAILURE_STREAK_RUN_LIMIT,
  type AgentScheduleLastRun,
  type AgentScheduleRun,
  type AgentScheduleRunReader,
} from "@/lib/agent-schedules/run-reader";
import {
  SCHEDULE_MUTATION_LOCK_LEASE_SECONDS,
  scheduleMutationLockKey,
} from "./mutation-lock";
import { createLogger } from "@/lib/logger";

const DEFAULT_MAX_SCHEDULES_PER_OWNER = 50;
const LAST_RUN_ERROR_MAX_LENGTH = 500;
const SCHEDULE_MAXIMUM_EVENT_AGE_SECONDS = 60 * 60;
const SCHEDULE_MAXIMUM_RETRY_ATTEMPTS = 5;
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
  /**
   * The expression actually handed to EventBridge Scheduler, after the 5-field
   * expansion and the `?` day-field rule. It is what the schedule MEANS; the
   * raw `cronExpression` is only what was typed.
   */
  schedulerExpression: string;
  /** Plain-language reading of `schedulerExpression`, for read-back. */
  description: string;
  /**
   * Next fire times in the schedule's timezone, ISO 8601 with offset. Empty
   * when the expression has no computable occurrences, and always empty when
   * `enabled` is false — a held schedule has no upcoming executions to
   * promise.
   *
   * Accurate to the minute, which is EventBridge's own guarantee: it invokes
   * every schedule type "with 60 second precision". For a `rate(...)`
   * schedule the phase is taken from `updatedAt`, the timestamp written
   * immediately before the Create/UpdateSchedule call — the platform anchors
   * on activation instead, which differs by that request's latency and so
   * sits well inside the same 60-second window. Pinning it exactly would
   * require sending `StartDate`, which for a rate schedule also redefines
   * its first occurrence.
   */
  nextRuns: string[];
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  /**
   * Failed runs since this schedule's last success. `lastRunStatus` alone
   * cannot tell a one-off blip from a job that has been broken for a month,
   * which is how ~30 staff kept a dead schedule without knowing (#1890).
   */
  consecutiveFailures: number;
  /**
   * `consecutiveFailures` is a FLOOR, not a total: the streak reached the
   * bounded number of runs the count is measured over. A reader must say "at
   * least N" rather than N, which is a number the owner could check and find
   * wrong — a five-minute schedule saturates this in about two days.
   */
  consecutiveFailuresCapped: boolean;
  /** `consecutiveFailures` has reached the attention threshold. */
  failing: boolean;
  degraded: boolean;
  degradedReason: string | null;
};

export interface CreateAgentScheduleInput {
  name: unknown;
  prompt: unknown;
  cron: unknown;
  timezone?: unknown;
  disabled?: unknown;
  /** Opt out of the likely-duplicate refusal when a second copy is intended. */
  confirmNew?: unknown;
}

export interface UpdateAgentScheduleInput {
  scheduleId: unknown;
  name?: unknown;
  prompt?: unknown;
  cron?: unknown;
  timezone?: unknown;
  enabled?: unknown;
  confirmNew?: unknown;
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

/**
 * Which condition in `create`'s TransactWrite failed.
 *
 * `CancellationReasons` comes back positionally, one entry per transact item,
 * so these indices must track the item order in `create`. A unit test pins
 * that order precisely so this mapping cannot drift silently.
 */
const CREATE_QUOTA_ITEM_INDEX = 0;
const CREATE_NAME_GUARD_ITEM_INDEX = 1;
const CONDITION_CHECK_FAILED = "ConditionalCheckFailed";

/**
 * The per-item cancellation codes DynamoDB attached to the exception, or null
 * when it did not carry any readable ones.
 *
 * Reading the reasons off the exception is what tells a name collision from
 * quota exhaustion *without* a second read: re-probing the guard row after the
 * fact loses to a concurrent delete, which would land right back on the
 * misleading quota error #1889 is about.
 */
function cancellationReasonCodes(error: unknown): string[] | null {
  if (!error || typeof error !== "object") return null;
  const reasons = (error as { CancellationReasons?: unknown })
    .CancellationReasons;
  if (!Array.isArray(reasons)) return null;
  return reasons.map((reason) => {
    if (!reason || typeof reason !== "object") return "";
    const code = (reason as { Code?: unknown }).Code;
    return typeof code === "string" ? code : "";
  });
}

/**
 * The result of reading a name guard row, kept distinct from "no row" so a
 * failed read can never be reported as an available name. See
 * `AgentScheduleService.nameGuardTarget`.
 */
type NameGuardProbe =
  | { status: "taken"; targetScheduleId: string | null }
  | { status: "free" }
  | { status: "unknown" };

/**
 * The machine-readable half of a 409, merged into the broker's response body.
 *
 * A closed union rather than a loose bag: the route spreads this straight into
 * the JSON response, so a future subtype that invented a key — `error` above
 * all, which would shadow the message — is a compile error here rather than a
 * surprise in the agent's hands.
 */
export type AgentScheduleConflictDetails =
  | { code: "name_conflict"; existingScheduleId: string | null }
  | {
      code: "possible_duplicate";
      existingScheduleId: string;
      existingScheduleName: string;
    };

export class AgentScheduleConflictError extends Error {
  /**
   * Extra fields the broker route merges into the 409 body.
   *
   * The agent acts on the machine-readable `code` and the existing schedule's
   * id; a prose message alone is what let it retry under a new name and create
   * a real duplicate. Absent on the integrity refusals, which are not
   * duplicates and have no id to offer.
   */
  readonly details?: AgentScheduleConflictDetails;

  constructor(message: string, details?: AgentScheduleConflictDetails) {
    super(message);
    this.name = "AgentScheduleConflictError";
    this.details = details;
  }
}

/**
 * The owner already has a schedule with this name.
 *
 * Previously every `TransactionCanceledException` from `create` became
 * `AgentScheduleQuotaError`, so a name collision on the `__name__<hash>` guard
 * row told the agent "Schedule quota exceeded (maximum 50)". The agent then
 * retried under a slightly different name — one counselor ended up with four
 * near-identical form watchers in a day.
 */
export class AgentScheduleNameConflictError extends AgentScheduleConflictError {
  constructor(scheduleName: string, existingScheduleId: string | null) {
    super(
      `A schedule named "${scheduleName}" already exists` +
        (existingScheduleId ? ` (${existingScheduleId})` : "") +
        ". Update or delete it instead of creating another.",
      {
        code: "name_conflict",
        existingScheduleId,
      },
    );
    this.name = "AgentScheduleNameConflictError";
  }
}

/**
 * An enabled schedule already runs the same prompt on the same cadence.
 *
 * Refused unless the caller passes `confirmNew: true`, because the common case
 * is an agent re-creating a job it should have updated: one counselor's daily
 * report ran twice every morning for exactly that reason.
 */
export class AgentSchedulePossibleDuplicateError extends AgentScheduleConflictError {
  constructor(existingScheduleId: string, existingScheduleName: string) {
    super(
      `An enabled schedule with the same cadence and prompt already exists: ` +
        `"${existingScheduleName}" (${existingScheduleId}). Update that ` +
        `schedule, or pass confirmNew to keep both anyway.`,
      {
        code: "possible_duplicate",
        existingScheduleId,
        existingScheduleName,
      },
    );
    this.name = "AgentSchedulePossibleDuplicateError";
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

/**
 * The failure-streak fields every schedule shape reports (#1890).
 *
 * Zeroed when run enrichment is unavailable: an unreadable history must not
 * read as a healthy schedule OR as a failing one, and `lastRunStatus` already
 * reports "unknown" for that case.
 */
function runHealth(
  runEnrichmentAvailable: boolean,
  consecutiveFailures: number,
): Pick<
  PublicAgentSchedule,
  "consecutiveFailures" | "consecutiveFailuresCapped" | "failing"
> {
  return runEnrichmentAvailable
    ? {
        consecutiveFailures,
        // Saturation is the server's to report, for the same reason `failing`
        // is: a reader that inferred it would need its own copy of the bound.
        consecutiveFailuresCapped:
          consecutiveFailures >= FAILURE_STREAK_RUN_LIMIT,
        failing: consecutiveFailures >= FAILING_SCHEDULE_THRESHOLD,
      }
    : {
        consecutiveFailures: 0,
        consecutiveFailuresCapped: false,
        failing: false,
      };
}

function publicSchedule(
  record: AgentScheduleRecord,
  lastRun?: AgentScheduleLastRun,
  runEnrichmentAvailable = true,
  consecutiveFailures = 0,
): PublicAgentSchedule {
  const summary = describeScheduleExpression(
    record.schedulerExpression,
    record.timezone,
    // `updatedAt` is when EventBridge last re-anchored a rate(...) interval.
    { anchor: record.updatedAt },
  );
  return {
    scheduleId: record.scheduleId,
    version: record.version,
    name: record.name,
    prompt: record.prompt,
    cronExpression: record.cronExpression,
    schedulerExpression: record.schedulerExpression,
    description: summary.description,
    // A disabled schedule cannot fire: EventBridge holds it, so reporting
    // upcoming times would promise executions that never happen in the field
    // SKILL.md tells the agent to confirm the schedule from. The description
    // still reads back what the expression means.
    nextRuns: record.enabled ? summary.nextRuns : [],
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
    ...runHealth(runEnrichmentAvailable, consecutiveFailures),
    degraded: false,
    degradedReason: null,
  };
}

function degradedString(
  value: unknown,
  maximumLength: number,
  fallback: string,
): string {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, maximumLength)
    : fallback;
}

function publicDegradedSchedule(
  value: Record<string, unknown>,
  lastRun?: AgentScheduleLastRun,
  runEnrichmentAvailable = true,
  consecutiveFailures = 0,
): PublicAgentSchedule {
  const schedulerExpression = degradedString(
    value.schedulerExpression,
    256,
    degradedString(value.cronExpression, 256, ""),
  );
  const timezone = degradedString(value.timezone, 100, DEFAULT_SCHEDULE_TIMEZONE);
  const updatedAt = degradedString(value.updatedAt, 64, "");
  const enabled = typeof value.enabled === "boolean" ? value.enabled : false;
  const summary = describeScheduleExpression(schedulerExpression, timezone, {
    // Empty or unparseable on a degraded row; a rate(...) schedule then
    // reports no fire times instead of ones measured from the wrong phase.
    anchor: updatedAt,
  });
  return {
    scheduleId: degradedString(value.scheduleId, 128, "unknown"),
    version:
      Number.isInteger(value.version) && Number(value.version) >= 1
        ? Number(value.version)
        : 0,
    name: degradedString(value.name, 120, "Invalid schedule"),
    prompt: degradedString(value.prompt, 20_000, ""),
    cronExpression: degradedString(value.cronExpression, 256, ""),
    schedulerExpression,
    description: summary.description,
    // Same rule as the normal path: no fire times for a schedule that cannot
    // fire. A degraded row defaults to disabled, so this is usually empty.
    nextRuns: enabled ? summary.nextRuns : [],
    timezone,
    enabled,
    createdAt: degradedString(value.createdAt, 64, ""),
    updatedAt,
    lastRunAt: lastRun?.createdAt.toISOString() ?? null,
    lastRunStatus: runEnrichmentAvailable
      ? lastRun?.status ?? null
      : "unknown",
    lastRunError: lastRun?.errorMessage
      ? lastRun.errorMessage.slice(0, LAST_RUN_ERROR_MAX_LENGTH)
      : null,
    ...runHealth(runEnrichmentAvailable, consecutiveFailures),
    degraded: true,
    degradedReason: "Schedule record requires migration",
  };
}

type ListableAgentSchedule =
  | { kind: "valid"; record: AgentScheduleRecord }
  | { kind: "degraded"; value: Record<string, unknown> };

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

/** An absent optional flag is false; anything non-boolean is a caller error. */
function parseOptionalFlag(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new AgentScheduleInputError(`${field} must be a boolean`);
  }
  return value;
}

const DUPLICATE_PROMPT_PREFIX_LENGTH = 200;

/** The fields that decide whether two schedules are the same job. */
interface DuplicateCandidate {
  name: string;
  schedulerExpression: string;
  timezone: string;
  prompt: string;
  /** The schedule being updated, which must not match itself. */
  scheduleId?: string;
}

/** The name normalization the name guard row is keyed by. */
function guardedName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizedForComparison(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizedPromptPrefix(prompt: string): string {
  return normalizedForComparison(prompt).slice(
    0,
    DUPLICATE_PROMPT_PREFIX_LENGTH,
  );
}

/**
 * Refuses a create or update that duplicates an existing schedule.
 *
 * Called before any DynamoDB or EventBridge write, so a refusal leaves nothing
 * to roll back and the agent gets the id of the schedule it should have
 * updated instead.
 *
 * Best-effort by construction, and deliberately so: it decides from a snapshot
 * read before the transaction, and `create` takes no owner-level lock, so two
 * genuinely concurrent creates can both pass. It catches the sequential
 * retry-under-a-new-name loop that #1889 is about, not a race. Closing the
 * race would need a second guard row keyed by cadence and prompt, conditioned
 * inside the same transaction as the name guard.
 */
function refuseIfLikelyDuplicate(
  records: AgentScheduleRecord[],
  candidate: DuplicateCandidate,
): void {
  const duplicate = findLikelyDuplicate(records, candidate);
  if (!duplicate) return;
  log.warn("Refusing a likely duplicate schedule", {
    existingScheduleId: duplicate.scheduleId,
  });
  throw new AgentSchedulePossibleDuplicateError(
    duplicate.scheduleId,
    duplicate.name,
  );
}

/**
 * An enabled schedule for this owner already running the same prompt on the
 * same cadence. Exact name equality is handled by the name guard row; this is
 * the "same job, slightly different name" case that had no check at all.
 *
 * A same-name record is skipped rather than matched: the name guard reports
 * it as `name_conflict`, which `confirmNew` cannot clear. Matching it here
 * would answer an identical retry with `possible_duplicate` and send the agent
 * to `--confirm-new`, only to hit the name conflict on the next attempt.
 *
 * The timezone is part of the cadence, not decoration: the same cron text in
 * `America/Los_Angeles` and `America/New_York` fires three hours apart, so two
 * such schedules are genuinely different jobs and must not be refused as
 * duplicates. `schedulerExpression` does not carry the zone — EventBridge
 * takes it as a separate field — so it has to be compared explicitly.
 */
function findLikelyDuplicate(
  records: AgentScheduleRecord[],
  candidate: DuplicateCandidate,
): AgentScheduleRecord | null {
  const expression = normalizedForComparison(candidate.schedulerExpression);
  const timezone = normalizedForComparison(candidate.timezone);
  const promptPrefix = normalizedPromptPrefix(candidate.prompt);
  const name = guardedName(candidate.name);
  return (
    records.find(
      (record) =>
        record.enabled &&
        record.scheduleId !== candidate.scheduleId &&
        guardedName(record.name) !== name &&
        normalizedForComparison(record.schedulerExpression) === expression &&
        normalizedForComparison(record.timezone) === timezone &&
        normalizedPromptPrefix(record.prompt) === promptPrefix,
    ) ?? null
  );
}

/**
 * Whether an update turns a schedule into a job it was not already running:
 * enabling it, or changing the cadence or prompt of an enabled one.
 *
 * Without this, `update` was a way around the create-time refusal — disable a
 * schedule, retime or re-prompt it to match another, re-enable it. A rename
 * alone is not checked, so a legacy pair that already double-fires can still
 * be edited without first being forced apart.
 */
function becomesRunningJob(
  current: AgentScheduleRecord,
  next: Pick<
    AgentScheduleRecord,
    "enabled" | "schedulerExpression" | "timezone" | "prompt"
  >,
): boolean {
  if (!next.enabled) return false;
  return (
    !current.enabled ||
    current.schedulerExpression !== next.schedulerExpression ||
    current.timezone !== next.timezone ||
    current.prompt !== next.prompt
  );
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
      .update(guardedName(name))
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

  private async withScheduleMutationLock<T>(
    ownerEmail: string,
    scheduleId: string,
    execute: () => Promise<T>,
  ): Promise<T> {
    const lockToken = randomUUID();
    const key = scheduleMutationLockKey({ ownerEmail, scheduleId });
    const nowS = Math.floor(Date.now() / 1000);
    try {
      await this.dynamo.send(
        new PutCommand({
          TableName: this.config.schedulesTable,
          Item: {
            ...key,
            kind: "schedule-mutation-lock",
            lockToken,
            expiresAt: nowS + SCHEDULE_MUTATION_LOCK_LEASE_SECONDS,
          },
          ConditionExpression:
            "attribute_not_exists(userId) OR expiresAt < :now",
          ExpressionAttributeValues: { ":now": nowS },
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      ) {
        throw new AgentScheduleConflictError(
          "Schedule is being updated; retry the request",
        );
      }
      throw error;
    }

    try {
      return await execute();
    } finally {
      try {
        await this.dynamo.send(
          new DeleteCommand({
            TableName: this.config.schedulesTable,
            Key: key,
            ConditionExpression: "lockToken = :lockToken",
            ExpressionAttributeValues: { ":lockToken": lockToken },
          }),
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ConditionalCheckFailedException"
        ) {
          log.warn("Schedule mutation lock release failed", {
            scheduleId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /**
   * Reconciles the quota and name-guard rows, and hands back the owner's
   * current schedule records.
   *
   * Backfills quota/name metadata for owners whose schedules predate the
   * transactional admission scheme. New mutations require the reconciled
   * marker, so concurrent creates cannot increment an unseeded zero counter.
   *
   * Returning the records is what lets `create` run its duplicate check
   * without a second consistent query — this method has already read every
   * row.
   */
  private async reconcileOwnerMetadata(
    ownerEmail: string,
  ): Promise<AgentScheduleRecord[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const items = await this.ownerItems(ownerEmail);
      const { records, quota, guards } = ownerMetadataSnapshot(items, ownerEmail);
      const transactItems = [
        ...this.planQuotaReconciliation(ownerEmail, records.length, quota),
        ...this.planNameGuardReconciliation(ownerEmail, records, guards),
      ];
      if (transactItems.length === 0) return records;
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
        return records;
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
    // Unreachable: the final attempt rethrows rather than continuing. Stated
    // as a throw rather than returning the last snapshot so the control flow
    // cannot be misread as a graceful give-up handing back stale records —
    // `create` would then run its duplicate check against a snapshot the
    // reconciliation never managed to settle.
    throw new AgentScheduleSyncError(
      "Schedule metadata reconciliation did not converge",
    );
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
    const candidates: ListableAgentSchedule[] = (await this.ownerItems(
      ownerEmail,
    ))
      .filter(
        (item) =>
          typeof item.scheduleId === "string" &&
          !item.scheduleId.startsWith("__"),
      )
      .flatMap((item): ListableAgentSchedule[] => {
        try {
          return [{ kind: "valid", record: parseRecord(item, ownerEmail) }];
        } catch (error) {
          if (!hasValidScheduleOwner(item, ownerEmail)) {
            log.warn("Skipping schedule with invalid owner binding", {
              scheduleId: degradedString(item.scheduleId, 128, "unknown"),
            });
            return [];
          }
          log.warn("Returning degraded schedule record", {
            scheduleId: degradedString(item.scheduleId, 128, "unknown"),
            error: error instanceof Error ? error.message : String(error),
          });
          return [{ kind: "degraded", value: item }];
        }
      })
      .sort((left, right) => {
        const leftCreatedAt =
          left.kind === "valid"
            ? left.record.createdAt
            : degradedString(left.value.createdAt, 64, "");
        const rightCreatedAt =
          right.kind === "valid"
            ? right.record.createdAt
            : degradedString(right.value.createdAt, 64, "");
        return leftCreatedAt.localeCompare(rightCreatedAt);
      });
    const scheduleIds = candidates.map((candidate) =>
      candidate.kind === "valid"
        ? candidate.record.scheduleId
        : degradedString(candidate.value.scheduleId, 128, "unknown"),
    );
    let lastRuns = new Map<string, AgentScheduleLastRun>();
    let failureStreaks = new Map<string, number>();
    let runEnrichmentAvailable = true;
    try {
      // One failure of either query degrades BOTH: reporting a last-run status
      // beside a silently-zeroed failure streak would say "last run failed,
      // not failing", which is worse than saying the history is unreadable.
      [lastRuns, failureStreaks] = await Promise.all([
        this.runReader.latestBySchedule(ownerEmail, scheduleIds),
        this.runReader.consecutiveFailuresBySchedule(ownerEmail, scheduleIds),
      ]);
    } catch (error) {
      runEnrichmentAvailable = false;
      lastRuns = new Map();
      failureStreaks = new Map();
      log.warn("Latest schedule run enrichment unavailable", {
        scheduleCount: candidates.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return candidates.map((candidate, index) =>
      candidate.kind === "valid"
        ? publicSchedule(
            candidate.record,
            lastRuns.get(scheduleIds[index]),
            runEnrichmentAvailable,
            failureStreaks.get(scheduleIds[index]) ?? 0,
          )
        : publicDegradedSchedule(
            candidate.value,
            lastRuns.get(scheduleIds[index]),
            runEnrichmentAvailable,
            failureStreaks.get(scheduleIds[index]) ?? 0,
          ),
    );
  }

  /**
   * Recent runs for this owner, so the agent can answer "why did my scheduled
   * job fail" instead of reporting that it cannot see its own history.
   *
   * Owner-scoped at the query, like every other operation here — a caller
   * cannot read another owner's runs by passing their scheduleId.
   */
  async runs(
    owner: string,
    input: { scheduleId?: unknown; limit?: unknown } = {},
  ): Promise<AgentScheduleRun[]> {
    const ownerEmail = normalizeOwnerEmail(owner);
    const scheduleId =
      typeof input.scheduleId === "string" && input.scheduleId.trim()
        ? input.scheduleId.trim()
        : undefined;
    // Integer, not merely finite: a fractional `limit` such as 1.5 survives the
    // reader's clamp and reaches Drizzle's `.limit()` as a fraction. The skill
    // validates this too, but the broker route is reachable owner-mode without
    // it, so the boundary that talks to the database enforces it as well.
    const limit =
      typeof input.limit === "number" && Number.isInteger(input.limit)
        ? input.limit
        : undefined;
    return this.runReader.recentForOwner(ownerEmail, { scheduleId, limit });
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
      input.timezone ?? DEFAULT_SCHEDULE_TIMEZONE,
    );
    const enabled = !parseOptionalFlag(input.disabled, "disabled");
    const confirmNew = parseOptionalFlag(input.confirmNew, "confirmNew");
    const existingRecords = await this.reconcileOwnerMetadata(ownerEmail);
    if (!confirmNew) {
      refuseIfLikelyDuplicate(existingRecords, {
        name,
        schedulerExpression,
        timezone,
        prompt,
      });
    }
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
      } catch (rollbackError) {
        // The EventBridge schedule now exists with no DynamoDB record behind
        // it. It never appears in `list`, so it is invisible to the owner, and
        // when it fires the cron Lambda finds no record. Log the handle an
        // operator needs to delete it — without this the orphan is
        // undiagnosable.
        log.error("Orphaned EventBridge schedule after failed rollback", {
          schedulerName,
          scheduleGroup: this.config.scheduleGroup,
          scheduleId,
          error:
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
        });
        throw new AgentScheduleSyncError(
          "Schedule persistence failed and scheduler rollback also failed",
        );
      }
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        throw await this.createCancellationError(ownerEmail, name, error);
      }
      throw error;
    }
    return publicSchedule(record);
  }

  /**
   * Tells a name collision apart from quota exhaustion.
   *
   * Both cancel the same transaction, and reporting the quota error for a
   * name collision is what drove agents to retry under a new name. The guard
   * row answers it on its own: if it exists, the name is taken; if it does
   * not, the name-guard condition would have succeeded, so the cancellation
   * was the quota one.
   */
  private async createCancellationError(
    ownerEmail: string,
    name: string,
    cancellation: unknown,
  ): Promise<Error> {
    // Preferred path: the exception says which condition failed, so no second
    // read can race it. The probe is still used for the existing schedule's
    // id, which the reasons do not carry — but a probe that comes back empty
    // only costs us the id, not the classification.
    const codes = cancellationReasonCodes(cancellation);
    if (codes) {
      if (codes[CREATE_NAME_GUARD_ITEM_INDEX] === CONDITION_CHECK_FAILED) {
        const probe = await this.nameGuardTarget(ownerEmail, name);
        return new AgentScheduleNameConflictError(
          name,
          probe.status === "taken" ? probe.targetScheduleId : null,
        );
      }
      if (codes[CREATE_QUOTA_ITEM_INDEX] === CONDITION_CHECK_FAILED) {
        return new AgentScheduleQuotaError(this.config.maxSchedulesPerOwner);
      }
    }
    const probe = await this.nameGuardTarget(ownerEmail, name);
    if (probe.status === "taken") {
      return new AgentScheduleNameConflictError(name, probe.targetScheduleId);
    }
    if (probe.status === "unknown") {
      // The probe itself failed, so we do not know why the write was
      // cancelled. Answering "quota exceeded" here would be the #1889 bug
      // with a new trigger: the agent would retry under a different name, or
      // delete a live schedule to make room.
      return new AgentScheduleSyncError(
        "Schedule creation was cancelled and the cause could not be " +
          "determined. Run list and retry.",
      );
    }
    return new AgentScheduleQuotaError(this.config.maxSchedulesPerOwner);
  }

  /**
   * Whether the owner's name guard row for this name exists.
   *
   * Three outcomes the caller must keep apart, which is why this is a tagged
   * union and not a nullable string: `taken` (the row is there, so the name is
   * in use), `free` (no such row, so the name-guard condition would have
   * succeeded and the cancellation was the quota one), and `unknown` (the read
   * itself failed, so we know nothing). Collapsing `unknown` into `free` is how
   * a transient DynamoDB throttle would come back out as "quota exceeded".
   *
   * A row whose `targetScheduleId` is missing or malformed is still `taken`
   * with a null id: the name is occupied either way, and reporting it as free
   * would send the agent back to the misleading quota error.
   */
  private async nameGuardTarget(
    ownerEmail: string,
    name: string,
  ): Promise<NameGuardProbe> {
    try {
      const response = await this.dynamo.send(
        new GetCommand({
          TableName: this.config.schedulesTable,
          Key: this.ownerNameKey(ownerEmail, name),
          ConsistentRead: true,
        }),
      );
      if (!response.Item) return { status: "free" };
      const target = response.Item.targetScheduleId;
      return {
        status: "taken",
        targetScheduleId: typeof target === "string" ? target : null,
      };
    } catch (error) {
      log.warn("Could not read the schedule name guard row", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: "unknown" };
    }
  }

  async update(
    owner: string,
    input: UpdateAgentScheduleInput,
  ): Promise<PublicAgentSchedule> {
    const ownerEmail = normalizeOwnerEmail(owner);
    const scheduleId = validateScheduleId(input.scheduleId);
    const confirmNew = parseOptionalFlag(input.confirmNew, "confirmNew");
    const existingRecords = await this.reconcileOwnerMetadata(ownerEmail);
    return this.withScheduleMutationLock(
      ownerEmail,
      scheduleId,
      () =>
        this.updateWhileLocked(ownerEmail, scheduleId, input, {
          existingRecords,
          confirmNew,
        }),
    );
  }

  private async updateWhileLocked(
    ownerEmail: string,
    scheduleId: string,
    input: UpdateAgentScheduleInput,
    duplicateCheck: {
      existingRecords: AgentScheduleRecord[];
      confirmNew: boolean;
    },
  ): Promise<PublicAgentSchedule> {
    const current = await this.getRecord(ownerEmail, scheduleId);
    const fields = resolvedScheduleFields(current, input);
    if (!duplicateCheck.confirmNew && becomesRunningJob(current, fields)) {
      refuseIfLikelyDuplicate(duplicateCheck.existingRecords, {
        ...fields,
        scheduleId,
      });
    }
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
    await this.reconcileOwnerMetadata(ownerEmail);
    return this.withScheduleMutationLock(
      ownerEmail,
      scheduleId,
      () => this.deleteWhileLocked(ownerEmail, scheduleId),
    );
  }

  private async deleteWhileLocked(
    ownerEmail: string,
    scheduleId: string,
  ): Promise<string> {
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
