/**
 * Agent Scheduler Sync Lambda
 *
 * DynamoDB Streams on psd-agent-schedules-{env} drive this Lambda. Each
 * INSERT / MODIFY / REMOVE event reconciles a single EventBridge Scheduler
 * schedule named `psd-agent-{env}-{scheduleId}` in the agent schedule group.
 *
 * Canonical schedule item shape in DynamoDB:
 *   {
 *     userId:          "hagelk@psd401.net",      // PK
 *     scheduleId:      "uuid",                    // SK
 *     name:            "Morning Brief",
 *     prompt:          "Generate my morning brief ...",
 *     cronExpression:  "0 9 * * MON-FRI *",       // 6-field cron in user timezone
 *     timezone:        "America/Los_Angeles",
 *     enabled:         true,
 *     googleIdentity:  "users/12345",
 *     dmSpaceName:     "spaces/abc" | undefined,
 *     createdAt:       "2026-04-21T20:00:00Z",
 *     updatedAt:       "2026-04-21T20:00:00Z"
 *   }
 *
 * Notes:
 *   - enabled=false ⇒ State: DISABLED on the Scheduler (schedule kept, not deleted).
 *   - Cron expressions are translated to EventBridge Scheduler's at()/rate()/cron()
 *     syntax. We accept standard 5- or 6-field cron and pass through to EventBridge
 *     as cron(...).
 */

import type { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ResourceNotFoundException,
  ConflictException,
} from '@aws-sdk/client-scheduler';

const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const SCHEDULE_GROUP_NAME = process.env.SCHEDULE_GROUP_NAME || `psd-agent-${ENVIRONMENT}`;
const CRON_LAMBDA_ARN = process.env.CRON_LAMBDA_ARN || '';
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN || '';
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/Los_Angeles';

const scheduler = new SchedulerClient({});

interface ScheduleItem {
  userId: string;
  scheduleId: string;
  name?: string;
  prompt?: string;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
  googleIdentity?: string;
  dmSpaceName?: string;
}

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string, meta: Record<string, unknown> = {}): void {
  const stream = level === 'ERROR' ? process.stderr : process.stdout;
  stream.write(
    JSON.stringify({
      level,
      message: msg,
      timestamp: new Date().toISOString(),
      service: 'agent-scheduler-sync',
      environment: ENVIRONMENT,
      ...meta,
    }) + '\n',
  );
}

function scheduleNameFor(scheduleId: string): string {
  // Group+name uniquely identify an EventBridge schedule. Keep names short
  // (<= 64 chars) and stable across updates. Prefix with environment so names
  // are human-readable in the console.
  return `psd-agent-${ENVIRONMENT}-${scheduleId}`.substring(0, 64);
}

/**
 * Normalize a cron expression into EventBridge Scheduler syntax.
 * EventBridge Scheduler requires 6-field cron: minute hour day month day-of-week year
 * Accepts either 5-field (adds '*' year) or 6-field unchanged.
 * Examples:
 *   "0 9 * * MON-FRI"       → "cron(0 9 * * MON-FRI *)"
 *   "0 9 * * MON-FRI *"     → "cron(0 9 * * MON-FRI *)"
 *   "cron(0 9 * * MON-FRI *)" → pass-through
 */
function toSchedulerExpression(cron: string): string {
  const trimmed = cron.trim();
  if (trimmed.startsWith('cron(') || trimmed.startsWith('rate(') || trimmed.startsWith('at(')) {
    return trimmed;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 5) {
    return `cron(${parts.join(' ')} *)`;
  }
  if (parts.length === 6) {
    return `cron(${parts.join(' ')})`;
  }
  throw new Error(`Invalid cron expression: "${cron}" (expected 5 or 6 fields, got ${parts.length})`);
}

function buildTargetPayload(item: ScheduleItem): string {
  return JSON.stringify({
    scheduleId: item.scheduleId,
    scheduleName: item.name ?? 'Scheduled Task',
    userEmail: item.userId,
    googleIdentity: item.googleIdentity,
    prompt: item.prompt ?? '',
    dmSpaceName: item.dmSpaceName,
  });
}

async function upsertSchedule(item: ScheduleItem): Promise<void> {
  if (!CRON_LAMBDA_ARN || !SCHEDULER_ROLE_ARN) {
    throw new Error('CRON_LAMBDA_ARN / SCHEDULER_ROLE_ARN not configured');
  }
  if (!item.prompt || !item.cronExpression) {
    log('WARN', 'Schedule missing required fields — skipping', {
      scheduleId: item.scheduleId,
      hasPrompt: !!item.prompt,
      hasCron: !!item.cronExpression,
    });
    return;
  }

  const scheduleName = scheduleNameFor(item.scheduleId);
  const expression = toSchedulerExpression(item.cronExpression);
  const timezone = item.timezone || DEFAULT_TIMEZONE;
  const state: 'ENABLED' | 'DISABLED' = item.enabled === false ? 'DISABLED' : 'ENABLED';

  const input = {
    Name: scheduleName,
    GroupName: SCHEDULE_GROUP_NAME,
    ScheduleExpression: expression,
    ScheduleExpressionTimezone: timezone,
    State: state,
    FlexibleTimeWindow: { Mode: 'OFF' as const },
    Target: {
      Arn: CRON_LAMBDA_ARN,
      RoleArn: SCHEDULER_ROLE_ARN,
      Input: buildTargetPayload(item),
    },
    Description: `PSD Agent schedule "${item.name ?? 'unnamed'}" for ${item.userId} (owner-managed)`,
  };

  try {
    // Try to fetch first to decide create vs update. Optimistic: CreateSchedule
    // throws ConflictException if it already exists — handle both.
    await scheduler.send(new GetScheduleCommand({
      Name: scheduleName,
      GroupName: SCHEDULE_GROUP_NAME,
    }));
    await scheduler.send(new UpdateScheduleCommand(input));
    log('INFO', 'Schedule updated', { scheduleId: item.scheduleId, state, expression });
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      try {
        await scheduler.send(new CreateScheduleCommand(input));
        log('INFO', 'Schedule created', { scheduleId: item.scheduleId, state, expression });
      } catch (createErr) {
        if (createErr instanceof ConflictException) {
          // Race: created between our Get and Create. Fall back to Update.
          await scheduler.send(new UpdateScheduleCommand(input));
          log('INFO', 'Schedule updated (after create-conflict)', {
            scheduleId: item.scheduleId,
            state,
            expression,
          });
        } else {
          throw createErr;
        }
      }
    } else {
      throw error;
    }
  }
}

async function deleteSchedule(scheduleId: string): Promise<void> {
  const scheduleName = scheduleNameFor(scheduleId);
  try {
    await scheduler.send(new DeleteScheduleCommand({
      Name: scheduleName,
      GroupName: SCHEDULE_GROUP_NAME,
    }));
    log('INFO', 'Schedule deleted', { scheduleId });
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      log('WARN', 'Delete requested for nonexistent schedule — no-op', { scheduleId });
      return;
    }
    throw error;
  }
}

function recordToItem(
  image: { [k: string]: AttributeValue } | undefined,
): ScheduleItem | null {
  if (!image) return null;
  const unmarshalled = unmarshall(image) as Partial<ScheduleItem>;
  if (!unmarshalled.userId || !unmarshalled.scheduleId) return null;
  return unmarshalled as ScheduleItem;
}

async function processRecord(record: DynamoDBRecord): Promise<void> {
  const eventName = record.eventName;
  const newImage = recordToItem(record.dynamodb?.NewImage as { [k: string]: AttributeValue } | undefined);
  const oldImage = recordToItem(record.dynamodb?.OldImage as { [k: string]: AttributeValue } | undefined);

  if (eventName === 'REMOVE') {
    if (oldImage) await deleteSchedule(oldImage.scheduleId);
    return;
  }

  // INSERT + MODIFY both upsert.
  if (!newImage) {
    log('WARN', 'Stream record missing NewImage — skipping', { eventName });
    return;
  }
  await upsertSchedule(newImage);
}

export async function handler(event: DynamoDBStreamEvent): Promise<{ processed: number }> {
  log('INFO', 'Stream batch received', { recordCount: event.Records.length });

  let processed = 0;
  for (const record of event.Records) {
    try {
      await processRecord(record);
      processed++;
    } catch (error) {
      // One bad record must not kill the whole batch, but we need to know.
      // Returning success-for-all avoids DDB stream retry storms when the
      // problem is a permanent config error (e.g. bad cron expression).
      log('ERROR', 'Failed to process stream record', {
        eventName: record.eventName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log('INFO', 'Stream batch completed', { processed, total: event.Records.length });
  return { processed };
}
