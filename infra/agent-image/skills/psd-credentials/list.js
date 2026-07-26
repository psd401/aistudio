#!/usr/bin/env node
/**
 * List credential names available to the signed invocation owner.
 * Usage: node list.js
 */

'use strict';

const {
  fail,
  parseArgs,
  rejectAuthorityArgs,
  emit,
  requestCredentialOperation,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: list.js');
    process.exit(0);
  }
  rejectAuthorityArgs(args);
  try {
    emit(await requestCredentialOperation({ operation: 'list' }));
  } catch (error) {
    fail(`Failed to list credentials: ${error.message}`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
