#!/usr/bin/env node

'use strict';

const {
  fail,
  rejectLegacyAuthorityArgs,
  validateTimezone,
  toSchedulerExpression,
  parseArgs,
  emit,
  requestScheduleOperation,
  failWithRefusal,
} = require('./common');

function parseBoolean(value) {
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  fail(`Invalid boolean "${value}" for --enabled.`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'Usage: update.js --schedule-id <id> [--name <n>] [--prompt <p>] ' +
        '[--cron <c>] [--timezone <tz>] [--enabled true|false] ' +
        '[--confirm-new]\n\n' +
        'The broker refuses an update that would leave this schedule an ' +
        'enabled copy of another one (code "possible_duplicate", HTTP 409 ' +
        'with the existing schedule id). Pass --confirm-new only when both ' +
        'are genuinely wanted.\n',
    );
    return;
  }
  rejectLegacyAuthorityArgs(args);
  if (!args['schedule-id'] || args['schedule-id'] === true) {
    fail('--schedule-id is required');
  }
  if (typeof args.timezone === 'string') validateTimezone(args.timezone);
  if (typeof args.cron === 'string') toSchedulerExpression(args.cron);
  const payload = {
    operation: 'update',
    scheduleId: args['schedule-id'],
  };
  if (typeof args.name === 'string') payload.name = args.name;
  if (typeof args.prompt === 'string') payload.prompt = args.prompt;
  if (typeof args.cron === 'string') payload.cron = args.cron;
  if (typeof args.timezone === 'string') payload.timezone = args.timezone;
  if (args.enabled !== undefined && args.enabled !== true) {
    payload.enabled = parseBoolean(args.enabled);
  }
  if (Object.keys(payload).length === 2) fail('No fields provided to update');
  if (args['confirm-new'] === true) payload.confirmNew = true;
  emit(await requestScheduleOperation(payload));
}

main().catch(failWithRefusal);
