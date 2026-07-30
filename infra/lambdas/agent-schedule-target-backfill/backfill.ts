import type {
  GetScheduleCommandOutput,
  UpdateScheduleCommandInput,
} from '@aws-sdk/client-scheduler';
import type {
  ScheduleMutationIdentity,
} from './mutation-lock';

const SCHEDULED_TIME_PLACEHOLDER = '<aws.scheduler.scheduled-time>';
const UPDATE_CONCURRENCY = 5;
const MAXIMUM_EVENT_AGE_SECONDS = 60 * 60;
const MAXIMUM_RETRY_ATTEMPTS = 5;
const IAM_PROPAGATION_ATTEMPTS = 8;
const SAFE_EMAIL_RE = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/;
const DM_SPACE_RE = /^spaces\/[\w-]{1,256}$/;
const UPDATEABLE_RECORD_FIELDS = [
  'version',
  'ownerEmail',
  'schedulerExpression',
  'workspacePrefix',
  'dmSpaceName',
] as const;

export type ScheduleBackfillPhase = 'records' | 'targets';

export interface ScheduleBackfillContinuation {
  phase: ScheduleBackfillPhase;
  nextToken?: string;
}

export interface TrustedOwnerProfile {
  dmSpaceName?: string;
  workspacePrefix: string;
}

export interface LegacyScheduleRecordUpgrade {
  version?: number;
  ownerEmail?: string;
  schedulerExpression?: string;
  workspacePrefix?: string;
  dmSpaceName?: string;
}

export interface ScheduleTargetBackfillDependencies {
  scheduleDlqArn: string;
  listRecords(nextToken?: string): Promise<{
    records: Record<string, unknown>[];
    nextToken?: string;
  }>;
  getRecord(
    identity: ScheduleMutationIdentity,
  ): Promise<Record<string, unknown> | undefined>;
  loadOwnerProfile(ownerEmail: string): Promise<TrustedOwnerProfile | null>;
  updateRecord(
    identity: ScheduleMutationIdentity,
    upgrade: LegacyScheduleRecordUpgrade,
  ): Promise<void>;
  list(nextToken?: string): Promise<{
    names: string[];
    nextToken?: string;
  }>;
  get(name: string): Promise<GetScheduleCommandOutput>;
  update(input: UpdateScheduleCommandInput): Promise<void>;
  queueContinuation(continuation: ScheduleBackfillContinuation): Promise<void>;
  withMutationLock<T>(
    identity: ScheduleMutationIdentity,
    execute: () => Promise<T>,
  ): Promise<T>;
  recordInvalidRecord(
    identity: ScheduleMutationIdentity | null,
    errorMessage: string,
  ): void;
  recordInvalidTarget(name: string, errorMessage: string): void;
}

export interface ScheduleTargetBackfillResult {
  phase: ScheduleBackfillPhase;
  scanned: number;
  updated: number;
  invalid: number;
  continuationQueued: boolean;
}

export class InvalidScheduleTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduleTargetError';
  }
}

function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof Error
    && (
      error.name === 'AccessDeniedException'
      || error.name === 'AccessDenied'
    )
  );
}

export async function withIamPropagationRetry<T>(
  operation: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> =
    (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = IAM_PROPAGATION_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isAccessDenied(error) || attempt === attempts) throw error;
      const delayMs = Math.min(2 ** (attempt - 1) * 1_000, 30_000);
      await wait(delayMs);
    }
  }
  throw lastError;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
  )
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
  );
}

function normalizedEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Mirror the broker's five/six-field cron normalization for legacy records.
 * The migration deliberately preserves the stored cronExpression verbatim and
 * derives only the EventBridge representation.
 */
export function legacySchedulerExpression(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidScheduleTargetError(
      'Legacy schedule record has no cron expression',
    );
  }
  const expression = value.trim();
  if (
    /^cron\(.+\)$/.test(expression)
    || /^rate\(.+\)$/.test(expression)
    || /^at\(.+\)$/.test(expression)
  ) {
    return expression;
  }
  const fields = expression.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new InvalidScheduleTargetError(
      'Legacy schedule record has an invalid cron expression',
    );
  }
  const expanded = fields.length === 5 ? [...fields, '*'] : [...fields];
  const dayOfMonthSpecified = expanded[2] !== '*' && expanded[2] !== '?';
  const dayOfWeekSpecified = expanded[4] !== '*' && expanded[4] !== '?';
  if (dayOfMonthSpecified && dayOfWeekSpecified) {
    throw new InvalidScheduleTargetError(
      'Legacy schedule record has an ambiguous cron expression',
    );
  }
  if (dayOfWeekSpecified) expanded[2] = '?';
  else expanded[4] = '?';
  return `cron(${expanded.join(' ')})`;
}

export function scheduleRecordIdentity(
  value: unknown,
): ScheduleMutationIdentity | null {
  const record = objectValue(value);
  if (!record || typeof record.scheduleId !== 'string') {
    throw new InvalidScheduleTargetError(
      'Legacy schedule record has no schedule identity',
    );
  }
  if (record.scheduleId.startsWith('__')) return null;
  const ownerEmail = normalizedEmail(record.userId);
  const scheduleId = record.scheduleId.trim().toLowerCase();
  if (
    !SAFE_EMAIL_RE.test(ownerEmail)
    || scheduleId.length === 0
    || scheduleId.length > 128
  ) {
    throw new InvalidScheduleTargetError(
      'Legacy schedule record has no owner-bound identity',
    );
  }
  return { ownerEmail, scheduleId };
}

function requiresTrustedOwnerProfile(
  record: Record<string, unknown>,
): boolean {
  return (
    typeof record.dmSpaceName !== 'string'
    || !DM_SPACE_RE.test(record.dmSpaceName)
    || !boundedString(record.workspacePrefix, 128)
  );
}

function legacyVersion(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 1 ? undefined : 1;
}

function legacyOwner(
  value: unknown,
  partitionOwner: string,
): string | undefined {
  const existingOwner = normalizedEmail(value);
  if (existingOwner && existingOwner !== partitionOwner) {
    throw new InvalidScheduleTargetError(
      'Legacy schedule record owner conflicts with its partition',
    );
  }
  return existingOwner ? undefined : partitionOwner;
}

function legacyExpression(
  record: Record<string, unknown>,
): string | undefined {
  return boundedString(record.schedulerExpression, 256)
    ? undefined
    : legacySchedulerExpression(record.cronExpression);
}

function legacyWorkspace(
  record: Record<string, unknown>,
  profile: TrustedOwnerProfile | null,
): string | undefined {
  if (boundedString(record.workspacePrefix, 128)) return undefined;
  if (!profile || !boundedString(profile.workspacePrefix, 128)) {
    throw new InvalidScheduleTargetError(
      'Legacy schedule owner has no trusted workspace profile',
    );
  }
  return profile.workspacePrefix;
}

function legacyDmSpace(
  record: Record<string, unknown>,
  profile: TrustedOwnerProfile | null,
): string | undefined {
  if (
    typeof record.dmSpaceName === 'string'
    && DM_SPACE_RE.test(record.dmSpaceName)
  ) {
    return undefined;
  }
  if (
    !profile
    || typeof profile.dmSpaceName !== 'string'
    || !DM_SPACE_RE.test(profile.dmSpaceName)
  ) {
    throw new InvalidScheduleTargetError(
      'Legacy schedule owner has no trusted direct-message destination',
    );
  }
  return profile.dmSpaceName;
}

function assignUpgrade<K extends keyof LegacyScheduleRecordUpgrade>(
  upgrade: LegacyScheduleRecordUpgrade,
  field: K,
  value: LegacyScheduleRecordUpgrade[K],
): void {
  if (value !== undefined) upgrade[field] = value;
}

export function legacyScheduleRecordUpgrade(
  value: unknown,
  profile: TrustedOwnerProfile | null,
): LegacyScheduleRecordUpgrade | null {
  const record = objectValue(value);
  const identity = scheduleRecordIdentity(record);
  if (!record || !identity) return null;

  const upgrade: LegacyScheduleRecordUpgrade = {};
  assignUpgrade(upgrade, 'version', legacyVersion(record.version));
  assignUpgrade(
    upgrade,
    'ownerEmail',
    legacyOwner(record.ownerEmail, identity.ownerEmail),
  );
  assignUpgrade(upgrade, 'schedulerExpression', legacyExpression(record));
  assignUpgrade(upgrade, 'workspacePrefix', legacyWorkspace(record, profile));
  assignUpgrade(upgrade, 'dmSpaceName', legacyDmSpace(record, profile));

  return UPDATEABLE_RECORD_FIELDS.some(
    (field) => upgrade[field] !== undefined,
  )
    ? upgrade
    : null;
}

export interface ScheduleTargetReference extends ScheduleMutationIdentity {
  version?: number;
}

function parsedTargetInput(
  rawInput: string | undefined,
): Record<string, unknown> {
  if (!rawInput) {
    throw new InvalidScheduleTargetError(
      'Schedule target is missing Input',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    throw new InvalidScheduleTargetError(
      'Schedule target Input is not valid JSON',
    );
  }
  const input = objectValue(parsed);
  if (!input) {
    throw new InvalidScheduleTargetError(
      'Schedule target Input is not an object',
    );
  }
  return input;
}

function targetOwner(input: Record<string, unknown>): string {
  const currentOwner = normalizedEmail(input.ownerEmail);
  const legacyOwnerEmail = normalizedEmail(input.userEmail);
  if (
    currentOwner
    && legacyOwnerEmail
    && currentOwner !== legacyOwnerEmail
  ) {
    throw new InvalidScheduleTargetError(
      'Schedule target Input has conflicting owners',
    );
  }
  return currentOwner || legacyOwnerEmail;
}

function targetScheduleId(input: Record<string, unknown>): string {
  return typeof input.scheduleId === 'string'
    ? input.scheduleId.trim().toLowerCase()
    : '';
}

function targetVersion(input: Record<string, unknown>): number | undefined {
  return Number.isInteger(input.version) && Number(input.version) >= 1
    ? Number(input.version)
    : undefined;
}

export function scheduleTargetReference(
  rawInput: string | undefined,
): ScheduleTargetReference {
  const input = parsedTargetInput(rawInput);
  const ownerEmail = targetOwner(input);
  const scheduleId = targetScheduleId(input);
  const version = targetVersion(input);
  if (
    !SAFE_EMAIL_RE.test(ownerEmail)
    || scheduleId.length === 0
    || scheduleId.length > 128
  ) {
    throw new InvalidScheduleTargetError(
      'Schedule target Input has no owner-bound reference',
    );
  }
  return {
    ownerEmail,
    scheduleId,
    ...(version ? { version } : {}),
  };
}

/**
 * EventBridge Scheduler stores Target.Input verbatim. Add the context token to
 * legacy records without changing their owner/version correlation fields.
 */
export function backfilledTargetInput(
  rawInput: string | undefined,
  authoritativeVersion?: number,
): string | null {
  const input = parsedTargetInput(rawInput);
  const reference = scheduleTargetReference(rawInput);
  const version = authoritativeVersion ?? reference.version;
  if (!Number.isInteger(version) || Number(version) < 1) {
    throw new InvalidScheduleTargetError(
      'Schedule target has no authoritative record version',
    );
  }
  const canonical = {
    ownerEmail: reference.ownerEmail,
    scheduleId: reference.scheduleId,
    version: Number(version),
    scheduledTime: SCHEDULED_TIME_PLACEHOLDER,
  };
  return (
    input.ownerEmail === canonical.ownerEmail
    && input.scheduleId === canonical.scheduleId
    && input.version === canonical.version
    && input.scheduledTime === canonical.scheduledTime
    && Object.keys(input).length === Object.keys(canonical).length
  )
    ? null
    : JSON.stringify(canonical);
}

function requiredScheduleFields(
  schedule: GetScheduleCommandOutput,
): asserts schedule is GetScheduleCommandOutput & {
  Name: string;
  ScheduleExpression: string;
  FlexibleTimeWindow: NonNullable<GetScheduleCommandOutput['FlexibleTimeWindow']>;
  Target: NonNullable<GetScheduleCommandOutput['Target']>;
} {
  if (
    !schedule.Name
    || !schedule.ScheduleExpression
    || !schedule.FlexibleTimeWindow
    || !schedule.Target
  ) {
    throw new InvalidScheduleTargetError(
      'Scheduler returned an incomplete schedule',
    );
  }
}

export function backfillUpdateRequest(
  schedule: GetScheduleCommandOutput,
  input: string,
  scheduleDlqArn: string,
): UpdateScheduleCommandInput {
  requiredScheduleFields(schedule);
  return {
    Name: schedule.Name,
    ...(schedule.GroupName ? { GroupName: schedule.GroupName } : {}),
    ScheduleExpression: schedule.ScheduleExpression,
    FlexibleTimeWindow: schedule.FlexibleTimeWindow,
    Target: {
      ...schedule.Target,
      Input: input,
      DeadLetterConfig: { Arn: scheduleDlqArn },
      RetryPolicy: {
        MaximumEventAgeInSeconds: MAXIMUM_EVENT_AGE_SECONDS,
        MaximumRetryAttempts: MAXIMUM_RETRY_ATTEMPTS,
      },
    },
    ...(schedule.ActionAfterCompletion
      ? { ActionAfterCompletion: schedule.ActionAfterCompletion }
      : {}),
    ...(schedule.Description ? { Description: schedule.Description } : {}),
    ...(schedule.EndDate ? { EndDate: schedule.EndDate } : {}),
    ...(schedule.KmsKeyArn ? { KmsKeyArn: schedule.KmsKeyArn } : {}),
    ...(schedule.ScheduleExpressionTimezone
      ? { ScheduleExpressionTimezone: schedule.ScheduleExpressionTimezone }
      : {}),
    ...(schedule.StartDate ? { StartDate: schedule.StartDate } : {}),
    ...(schedule.State ? { State: schedule.State } : {}),
  };
}

function hasCurrentDeliveryPolicy(
  schedule: GetScheduleCommandOutput,
  scheduleDlqArn: string,
): boolean {
  return (
    schedule.Target?.DeadLetterConfig?.Arn === scheduleDlqArn
    && schedule.Target?.RetryPolicy?.MaximumEventAgeInSeconds
      === MAXIMUM_EVENT_AGE_SECONDS
    && schedule.Target?.RetryPolicy?.MaximumRetryAttempts
      === MAXIMUM_RETRY_ATTEMPTS
  );
}

function isResourceNotFound(error: unknown): boolean {
  return (
    error instanceof Error
    && error.name === 'ResourceNotFoundException'
  );
}

function authoritativeRecordVersion(
  value: unknown,
  identity: ScheduleMutationIdentity,
): number {
  const record = objectValue(value);
  if (
    !record
    || normalizedEmail(record.userId) !== identity.ownerEmail
    || normalizedEmail(record.ownerEmail) !== identity.ownerEmail
    || record.scheduleId !== identity.scheduleId
    || !Number.isInteger(record.version)
    || Number(record.version) < 1
  ) {
    throw new InvalidScheduleTargetError(
      'Schedule target has no matching authoritative record',
    );
  }
  return Number(record.version);
}

async function updateOneRecord(
  rawRecord: Record<string, unknown>,
  dependencies: ScheduleTargetBackfillDependencies,
): Promise<boolean> {
  const identity = scheduleRecordIdentity(rawRecord);
  if (!identity) return false;
  return dependencies.withMutationLock(identity, async () => {
    const current = await dependencies.getRecord(identity);
    if (!current) {
      throw new InvalidScheduleTargetError(
        'Legacy schedule record disappeared during migration',
      );
    }
    const profile = requiresTrustedOwnerProfile(current)
      ? await dependencies.loadOwnerProfile(identity.ownerEmail)
      : null;
    const upgrade = legacyScheduleRecordUpgrade(current, profile);
    if (!upgrade) return false;
    await dependencies.updateRecord(identity, upgrade);
    return true;
  });
}

export async function backfillScheduleRecordPage(
  nextToken: string | undefined,
  dependencies: ScheduleTargetBackfillDependencies,
): Promise<ScheduleTargetBackfillResult> {
  const page = await dependencies.listRecords(nextToken);
  let updated = 0;
  let invalid = 0;
  for (
    let offset = 0;
    offset < page.records.length;
    offset += UPDATE_CONCURRENCY
  ) {
    const outcomes = await Promise.all(
      page.records
        .slice(offset, offset + UPDATE_CONCURRENCY)
        .map(async (record) => {
          let identity: ScheduleMutationIdentity | null = null;
          try {
            identity = scheduleRecordIdentity(record);
            return {
              updated: await updateOneRecord(record, dependencies),
              invalid: false,
            };
          } catch (error) {
            if (!(error instanceof InvalidScheduleTargetError)) throw error;
            dependencies.recordInvalidRecord(identity, error.message);
            return { updated: false, invalid: true };
          }
        }),
    );
    updated += outcomes.filter((outcome) => outcome.updated).length;
    invalid += outcomes.filter((outcome) => outcome.invalid).length;
  }
  await dependencies.queueContinuation(
    page.nextToken
      ? { phase: 'records', nextToken: page.nextToken }
      : { phase: 'targets' },
  );
  return {
    phase: 'records',
    scanned: page.records.length,
    updated,
    invalid,
    continuationQueued: true,
  };
}

async function updateOne(
  name: string,
  dependencies: ScheduleTargetBackfillDependencies,
): Promise<boolean> {
  let initial: GetScheduleCommandOutput;
  try {
    initial = await dependencies.get(name);
  } catch (error) {
    if (isResourceNotFound(error)) return false;
    throw error;
  }
  const initialReference = scheduleTargetReference(initial.Target?.Input);
  return dependencies.withMutationLock(initialReference, async () => {
    let schedule: GetScheduleCommandOutput;
    try {
      // Re-read only after acquiring the lock shared with user mutations.
      schedule = await dependencies.get(name);
    } catch (error) {
      if (isResourceNotFound(error)) return false;
      throw error;
    }
    const currentReference = scheduleTargetReference(schedule.Target?.Input);
    if (
      currentReference.ownerEmail !== initialReference.ownerEmail
      || currentReference.scheduleId !== initialReference.scheduleId
    ) {
      throw new Error('Schedule target ownership changed during backfill');
    }
    const record = await dependencies.getRecord(currentReference);
    const version = authoritativeRecordVersion(record, currentReference);
    const input = backfilledTargetInput(schedule.Target?.Input, version);
    if (
      input === null
      && hasCurrentDeliveryPolicy(schedule, dependencies.scheduleDlqArn)
    ) {
      return false;
    }
    await dependencies.update(
      backfillUpdateRequest(
        schedule,
        input ?? schedule.Target?.Input ?? '',
        dependencies.scheduleDlqArn,
      ),
    );
    return true;
  });
}

export async function backfillScheduleTargetPage(
  nextToken: string | undefined,
  dependencies: ScheduleTargetBackfillDependencies,
): Promise<ScheduleTargetBackfillResult> {
  const page = await dependencies.list(nextToken);
  let updated = 0;
  let invalid = 0;
  for (
    let offset = 0;
    offset < page.names.length;
    offset += UPDATE_CONCURRENCY
  ) {
    const outcomes = await Promise.all(
      page.names
        .slice(offset, offset + UPDATE_CONCURRENCY)
        .map(async (name) => {
          try {
            return {
              updated: await updateOne(name, dependencies),
              invalid: false,
            };
          } catch (error) {
            // A permanently malformed legacy target must not poison this
            // one-shot fleet migration and strand every later page. Skip only
            // validation failures; operational Scheduler/Dynamo/Lambda errors
            // still reject the invocation for async retry and DLQ handling.
            if (!(error instanceof InvalidScheduleTargetError)) throw error;
            dependencies.recordInvalidTarget(name, error.message);
            return { updated: false, invalid: true };
          }
        }),
    );
    updated += outcomes.filter((outcome) => outcome.updated).length;
    invalid += outcomes.filter((outcome) => outcome.invalid).length;
  }
  if (page.nextToken) {
    await dependencies.queueContinuation({
      phase: 'targets',
      nextToken: page.nextToken,
    });
  }
  return {
    phase: 'targets',
    scanned: page.names.length,
    updated,
    invalid,
    continuationQueued: Boolean(page.nextToken),
  };
}
