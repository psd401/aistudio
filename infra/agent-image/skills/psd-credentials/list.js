#!/usr/bin/env node
/**
 * list.js — credentials.list
 * Usage: node list.js --user <email>
 *
 * Lists all credentials the user has access to (names and scopes,
 * never values).
 */

'use strict';

const {
  fail,
  validateEnv,
  validateUserEmail,
  parseArgs,
  emit,
  listCredentials,
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
    const credentials = await listCredentials(args.user);
    emit({ credentials, count: credentials.length });
  } catch (err) {
    fail(`Failed to list credentials: ${err.message}`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
