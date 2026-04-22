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
} = require('./common');

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
