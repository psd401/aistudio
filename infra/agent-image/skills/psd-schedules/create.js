#!/usr/bin/env node
/**
 * create.js — create_schedule
 *
 * Usage:
 *   node create.js \
 *     --user <email> \
 *     --name "<display>" \
 *     --prompt "<prompt>" \
 *     --cron "<5-field cron>" \
 *     [--timezone "<IANA TZ>"] \
 *     [--google-identity "<users/...>"] \
 *     [--dm-space-name "<spaces/...>"] \
 *     [--disabled]
 */

'use strict';

const {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
} = require('@aws-sdk/client-scheduler');

const {
  REGION,
  SCHEDULE_GROUP,
  CRON_LAMBDA_ARN,
  EVENTBRIDGE_ROLE_ARN,
  DEFAULT_TIMEZONE,
  fail,
  validateEnv,
  validateUserEmail,
  validateTimezone,
  toSchedulerExpression,
  generateScheduleId,
  buildScheduleName,
  parseArgs,
  nowIso,
  emit,
  putSchedule,
  querySchedules,
} = require('./common');

// Per-user ceiling. Prevents one user from exhausting EventBridge
// Scheduler's account-level quota (soft: 1,000 / hard: 10,000 per account).
// Bumpable via env for a power user if ever needed.
const MAX_SCHEDULES_PER_USER = parseInt(process.env.MAX_SCHEDULES_PER_USER || '50', 10);

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: create.js --user <email> --name <name> --prompt <prompt> --cron <cron> [--timezone <tz>] [--google-identity <id>] [--dm-space-name <name>] [--disabled]');
    process.exit(0);
  }

  validateEnv();
  validateUserEmail(args.user);
  if (!args.name) fail('--name is required');
  if (!args.prompt) fail('--prompt is required');
  if (!args.cron) fail('--cron is required');

  const timezone = args.timezone || DEFAULT_TIMEZONE;
  validateTimezone(timezone);
  const expression = toSchedulerExpression(args.cron);

  // Idempotency + quota checks before allocating resources.
  // NOTE: name-uniqueness is BEST-EFFORT. The schedules table is keyed by
  // (userId, scheduleId), not name, so DynamoDB cannot enforce name
  // uniqueness with a ConditionExpression. Two truly-concurrent creates with
  // the same name can both pass the check before either writes. Accepted:
  // skill invocations are single-threaded per Chat turn, and the human-in-
  // the-loop (agent reads back the proposed schedule before creating) makes
  // concurrent same-name creates extremely unlikely in practice.
  let existing;
  try {
    existing = await querySchedules(args.user);
  } catch (err) {
    fail(`DynamoDB Query failed (pre-create check): ${err.message}`);
  }
  if (existing.length >= MAX_SCHEDULES_PER_USER) {
    fail(
      `Schedule quota exceeded: ${args.user} already has ${existing.length} ` +
        `schedules (max ${MAX_SCHEDULES_PER_USER}). Delete unused schedules first.`,
    );
  }
  const nameCollision = existing.find((s) => s.name === args.name);
  if (nameCollision) {
    fail(
      `A schedule named "${args.name}" already exists for ${args.user} ` +
        `(id ${nameCollision.scheduleId}). Use a different name or update the existing schedule.`,
    );
  }

  const scheduleId = generateScheduleId();
  const ebName = buildScheduleName(scheduleId);
  const state = args.disabled ? 'DISABLED' : 'ENABLED';

  const now = nowIso();
  const record = {
    userId: args.user,
    scheduleId,
    name: args.name,
    prompt: args.prompt,
    cronExpression: args.cron,
    timezone,
    enabled: !args.disabled,
    createdAt: now,
    updatedAt: now,
  };
  if (args['google-identity']) record.googleIdentity = args['google-identity'];
  if (args['dm-space-name']) record.dmSpaceName = args['dm-space-name'];

  const lambdaInput = JSON.stringify({
    scheduleId,
    scheduleName: args.name,
    userEmail: args.user,
    googleIdentity: record.googleIdentity,
    dmSpaceName: record.dmSpaceName,
    prompt: args.prompt,
  });

  const scheduler = new SchedulerClient({ region: REGION });
  try {
    await scheduler.send(new CreateScheduleCommand({
      Name: ebName,
      GroupName: SCHEDULE_GROUP,
      ScheduleExpression: expression,
      ScheduleExpressionTimezone: timezone,
      FlexibleTimeWindow: { Mode: 'OFF' },
      State: state,
      Target: {
        Arn: CRON_LAMBDA_ARN,
        RoleArn: EVENTBRIDGE_ROLE_ARN,
        Input: lambdaInput,
      },
      Description: `PSD agent schedule "${args.name}" for ${args.user}`,
    }));
  } catch (err) {
    fail(`EventBridge CreateSchedule failed: ${err.message}`);
  }

  try {
    await putSchedule(record);
  } catch (err) {
    // Rollback: delete the EventBridge schedule so we don't leave it orphaned
    // firing forever against a Lambda payload we never recorded.
    try {
      await scheduler.send(new DeleteScheduleCommand({
        Name: ebName,
        GroupName: SCHEDULE_GROUP,
      }));
    } catch (rollbackErr) {
      console.error(
        `Rollback failed — orphaned EB schedule ${ebName}: ${rollbackErr.message}`,
      );
    }
    fail(`DynamoDB PutItem failed (EB schedule rolled back): ${err.message}`);
  }

  emit({ created: record, eventbridgeName: ebName, expression });
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
