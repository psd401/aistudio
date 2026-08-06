#!/usr/bin/env node

'use strict';

const {
  fail,
  rejectLegacyAuthorityArgs,
  parseArgs,
  emit,
  requestScheduleOperation,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'Usage: runs.js [--schedule-id <id>] [--limit <1-50>]\n' +
        '\n' +
        'Recent runs for your schedules, newest first, with the error message\n' +
        'for any that failed. Use this to answer "why did my scheduled job\n' +
        'fail" — `list` reports a status but never the reason.\n',
    );
    return;
  }
  rejectLegacyAuthorityArgs(args);

  const scheduleId = args['schedule-id'];
  if (scheduleId === true) fail('--schedule-id requires a value');

  const limitArg = args.limit;
  let limit;
  if (limitArg !== undefined) {
    // A valueless --limit parses as `true`, and Number(true) is 1 — without this
    // guard a malformed invocation silently becomes `--limit 1`.
    if (limitArg === true) fail('--limit requires a value');
    limit = Number(limitArg);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      fail('--limit must be an integer between 1 and 50');
    }
  }

  const result = await requestScheduleOperation({
    operation: 'runs',
    ...(scheduleId ? { scheduleId } : {}),
    ...(limit === undefined ? {} : { limit }),
  });
  emit(result);
}

if (require.main === module) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
