#!/usr/bin/env node
/**
 * delete.js — delete_schedule
 * Usage: node delete.js --user <email> --schedule-id <id>
 */

'use strict';

const {
  SchedulerClient,
  DeleteScheduleCommand,
  ResourceNotFoundException,
} = require('@aws-sdk/client-scheduler');

const {
  REGION,
  SCHEDULE_GROUP,
  fail,
  validateEnv,
  validateUserEmail,
  buildScheduleName,
  parseArgs,
  emit,
  getSchedule,
  deleteScheduleItem,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: delete.js --user <email> --schedule-id <id>');
    process.exit(0);
  }
  validateEnv();
  validateUserEmail(args.user);
  const scheduleId = args['schedule-id'];
  if (!scheduleId) fail('--schedule-id is required');

  const existing = await getSchedule(args.user, scheduleId);
  if (!existing) fail(`Schedule ${scheduleId} not found for ${args.user}`, 1);

  const ebName = buildScheduleName(scheduleId);
  const scheduler = new SchedulerClient({ region: REGION });
  try {
    await scheduler.send(new DeleteScheduleCommand({
      Name: ebName,
      GroupName: SCHEDULE_GROUP,
    }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      // Already gone; continue to remove the DDB record so state converges.
    } else {
      fail(`EventBridge DeleteSchedule failed: ${err.message}`);
    }
  }

  try {
    await deleteScheduleItem(args.user, scheduleId);
  } catch (err) {
    fail(`DynamoDB DeleteItem failed: ${err.message}`);
  }

  emit({ deleted: scheduleId });
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
