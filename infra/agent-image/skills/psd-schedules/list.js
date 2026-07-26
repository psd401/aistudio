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
    process.stdout.write('Usage: list.js\n');
    return;
  }
  rejectLegacyAuthorityArgs(args);
  emit(await requestScheduleOperation({ operation: 'list' }));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
