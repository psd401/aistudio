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

export interface ScheduleTargetBackfillDependencies {
  scheduleDlqArn: string;
  list(nextToken?: string): Promise<{
    names: string[];
    nextToken?: string;
  }>;
  get(name: string): Promise<GetScheduleCommandOutput>;
  update(input: UpdateScheduleCommandInput): Promise<void>;
  queueContinuation(nextToken: string): Promise<void>;
  withMutationLock<T>(
    identity: ScheduleMutationIdentity,
    execute: () => Promise<T>,
  ): Promise<T>;
}

export interface ScheduleTargetBackfillResult {
  scanned: number;
  updated: number;
  continuationQueued: boolean;
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

export interface ScheduleTargetReference extends ScheduleMutationIdentity {
  version: number;
}

export function scheduleTargetReference(
  rawInput: string | undefined,
): ScheduleTargetReference {
  if (!rawInput) throw new Error('Schedule target is missing Input');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    throw new Error('Schedule target Input is not valid JSON');
  }
  const input = objectValue(parsed);
  if (
    !input
    || typeof input.ownerEmail !== 'string'
    || typeof input.scheduleId !== 'string'
    || typeof input.version !== 'number'
  ) {
    throw new Error('Schedule target Input has no owner-bound reference');
  }
  return {
    ownerEmail: input.ownerEmail.trim().toLowerCase(),
    scheduleId: input.scheduleId,
    version: input.version,
  };
}

/**
 * EventBridge Scheduler stores Target.Input verbatim. Add the context token to
 * legacy records without changing their owner/version correlation fields.
 */
export function backfilledTargetInput(
  rawInput: string | undefined,
): string | null {
  if (!rawInput) throw new Error('Schedule target is missing Input');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    throw new Error('Schedule target Input is not valid JSON');
  }
  const input = objectValue(parsed);
  scheduleTargetReference(rawInput);
  if (!input) throw new Error('Schedule target Input is not an object');
  if (input.scheduledTime === SCHEDULED_TIME_PLACEHOLDER) return null;
  return JSON.stringify({
    ...input,
    scheduledTime: SCHEDULED_TIME_PLACEHOLDER,
  });
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
    throw new Error('Scheduler returned an incomplete schedule');
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
    const input = backfilledTargetInput(schedule.Target?.Input);
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
  for (
    let offset = 0;
    offset < page.names.length;
    offset += UPDATE_CONCURRENCY
  ) {
    const outcomes = await Promise.all(
      page.names
        .slice(offset, offset + UPDATE_CONCURRENCY)
        .map((name) => updateOne(name, dependencies)),
    );
    updated += outcomes.filter(Boolean).length;
  }
  if (page.nextToken) {
    await dependencies.queueContinuation(page.nextToken);
  }
  return {
    scanned: page.names.length,
    updated,
    continuationQueued: Boolean(page.nextToken),
  };
}
