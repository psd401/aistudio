import type {
  GetScheduleCommandOutput,
  UpdateScheduleCommandInput,
} from '@aws-sdk/client-scheduler';

const SCHEDULED_TIME_PLACEHOLDER = '<aws.scheduler.scheduled-time>';
const UPDATE_CONCURRENCY = 5;

export interface ScheduleTargetBackfillDependencies {
  list(nextToken?: string): Promise<{
    names: string[];
    nextToken?: string;
  }>;
  get(name: string): Promise<GetScheduleCommandOutput>;
  update(input: UpdateScheduleCommandInput): Promise<void>;
  queueContinuation(nextToken: string): Promise<void>;
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
  if (
    !input
    || typeof input.ownerEmail !== 'string'
    || typeof input.scheduleId !== 'string'
    || typeof input.version !== 'number'
  ) {
    throw new Error('Schedule target Input has no owner-bound reference');
  }
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
): UpdateScheduleCommandInput {
  requiredScheduleFields(schedule);
  return {
    Name: schedule.Name,
    ...(schedule.GroupName ? { GroupName: schedule.GroupName } : {}),
    ScheduleExpression: schedule.ScheduleExpression,
    FlexibleTimeWindow: schedule.FlexibleTimeWindow,
    Target: { ...schedule.Target, Input: input },
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

async function updateOne(
  name: string,
  dependencies: ScheduleTargetBackfillDependencies,
): Promise<boolean> {
  const schedule = await dependencies.get(name);
  const input = backfilledTargetInput(schedule.Target?.Input);
  if (input === null) return false;
  await dependencies.update(backfillUpdateRequest(schedule, input));
  return true;
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
