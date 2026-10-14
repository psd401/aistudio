#!/usr/bin/env node

'use strict';

const {
  DEFAULT_TIMEZONE,
  fail,
  rejectLegacyAuthorityArgs,
  validateTimezone,
  toSchedulerExpression,
  parseArgs,
  emit,
  requestScheduleOperation,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'Usage: create.js --name <name> --prompt <prompt> --cron <cron> ' +
        '[--timezone <tz>] [--disabled] [--confirm-new]\n\n' +
        'Run list.js first. The broker refuses a second enabled schedule ' +
        'with the same cadence and prompt (code "possible_duplicate") and a ' +
        'name that is already taken (code "name_conflict"), both HTTP 409 ' +
        'with the existing schedule id. Pass --confirm-new only when a ' +
        'second copy is genuinely wanted.\n',
    );
    return;
  }
  rejectLegacyAuthorityArgs(args);
  if (!args.name || args.name === true) fail('--name is required');
  if (!args.prompt || args.prompt === true) fail('--prompt is required');
  if (!args.cron || args.cron === true) fail('--cron is required');
  const timezone =
    typeof args.timezone === 'string' ? args.timezone : DEFAULT_TIMEZONE;
  validateTimezone(timezone);
  toSchedulerExpression(args.cron);
  emit(
    await requestScheduleOperation({
      operation: 'create',
      name: args.name,
      prompt: args.prompt,
      cron: args.cron,
      timezone,
      disabled: args.disabled === true,
      confirmNew: args['confirm-new'] === true,
    }),
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
