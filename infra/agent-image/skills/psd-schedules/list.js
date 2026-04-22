#!/usr/bin/env node
/**
 * list.js — list_schedules
 * Usage: node list.js --user <email>
 */

'use strict';

const {
  fail,
  validateEnv,
  validateUserEmail,
  parseArgs,
  emit,
  querySchedules,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: list.js --user <email>');
    process.exit(0);
  }
  validateEnv();
  validateUserEmail(args.user);

  try {
    const items = await querySchedules(args.user);
    emit({ schedules: items, count: items.length });
  } catch (err) {
    fail(`DynamoDB Query failed: ${err.message}`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
