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
    process.stdout.write('Usage: delete.js --schedule-id <id>\n');
    return;
  }
  rejectLegacyAuthorityArgs(args);
  if (!args['schedule-id'] || args['schedule-id'] === true) {
    fail('--schedule-id is required');
  }
  emit(
    await requestScheduleOperation({
      operation: 'delete',
      scheduleId: args['schedule-id'],
    }),
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
