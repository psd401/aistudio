#!/usr/bin/env node
/**
 * update.js — update_schedule
 *
 * Usage:
 *   node update.js --user <email> --schedule-id <id> \
 *     [--name <n>] [--prompt <p>] [--cron <c>] [--timezone <tz>] \
 *     [--enabled true|false]
 *
 * Writes the DynamoDB record first, then updates the EventBridge Scheduler
 * entry to match. If EB update fails, the DDB change is left in place and
 * logged so the next list shows the intended state (user can retry).
 */

'use strict';

const {
  SchedulerClient,
  UpdateScheduleCommand,
} = require('@aws-sdk/client-scheduler');

const {
  REGION,
  SCHEDULE_GROUP,
  CRON_LAMBDA_ARN,
  EVENTBRIDGE_ROLE_ARN,
  fail,
  validateEnv,
  validateUserEmail,
  validateTimezone,
  toSchedulerExpression,
  buildScheduleName,
  parseArgs,
  emit,
  getSchedule,
  updateScheduleItem,
} = require('./common');

function parseBool(value) {
  const s = String(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  fail(`Invalid boolean "${value}" for --enabled. Use true or false.`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: update.js --user <email> --schedule-id <id> [--name <n>] [--prompt <p>] [--cron <c>] [--timezone <tz>] [--enabled true|false]');
    process.exit(0);
  }
  validateEnv();
  validateUserEmail(args.user);
  const scheduleId = args['schedule-id'];
  if (!scheduleId) fail('--schedule-id is required');

  const existing = await getSchedule(args.user, scheduleId);
  if (!existing) fail(`Schedule ${scheduleId} not found for ${args.user}`, 1);

  // Collect DDB updates from provided flags.
  const updates = {};
  if (args.name !== undefined && args.name !== true) updates.name = args.name;
  if (args.prompt !== undefined && args.prompt !== true) updates.prompt = args.prompt;
  if (args.cron !== undefined && args.cron !== true) updates.cronExpression = args.cron;
  if (args.timezone !== undefined && args.timezone !== true) updates.timezone = args.timezone;
  if (args.enabled !== undefined && args.enabled !== true) {
    updates.enabled = parseBool(args.enabled);
  }

  if (Object.keys(updates).length === 0) {
    fail('No fields provided to update');
  }

  if (updates.timezone) validateTimezone(updates.timezone);

  // Apply to DDB (source of truth).
  const updated = await updateScheduleItem(args.user, scheduleId, updates);
  if (!updated) fail('DynamoDB UpdateItem returned no attributes');

  // Reconcile EventBridge Scheduler to the new DDB state.
  const expression = toSchedulerExpression(updated.cronExpression);
  const ebName = buildScheduleName(scheduleId);
  const state = updated.enabled === false ? 'DISABLED' : 'ENABLED';
  const lambdaInput = JSON.stringify({
    scheduleId: updated.scheduleId,
    scheduleName: updated.name,
    userEmail: updated.userId,
    googleIdentity: updated.googleIdentity,
    dmSpaceName: updated.dmSpaceName,
    prompt: updated.prompt,
  });

  const scheduler = new SchedulerClient({ region: REGION });
  try {
    await scheduler.send(new UpdateScheduleCommand({
      Name: ebName,
      GroupName: SCHEDULE_GROUP,
      ScheduleExpression: expression,
      ScheduleExpressionTimezone: updated.timezone,
      FlexibleTimeWindow: { Mode: 'OFF' },
      State: state,
      Target: {
        Arn: CRON_LAMBDA_ARN,
        RoleArn: EVENTBRIDGE_ROLE_ARN,
        Input: lambdaInput,
      },
      Description: `PSD agent schedule "${updated.name}" for ${updated.userId}`,
    }));
  } catch (err) {
    // DDB is now ahead of EventBridge. Surface this explicitly in stdout so
    // the agent sees the drift and can report "schedule looks updated but
    // the scheduler is still running the old config — retry".
    emit({
      ebSyncFailed: true,
      updated,
      eventbridgeName: ebName,
      expression,
      state,
      error: err.message,
      remediation:
        'Retry the same update command. DDB reflects the intended state; ' +
        'EventBridge is still on the previous configuration.',
    });
    process.exit(1);
  }

  emit({ updated, eventbridgeName: ebName, expression, state });
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
