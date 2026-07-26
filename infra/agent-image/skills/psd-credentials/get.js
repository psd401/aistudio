#!/usr/bin/env node
/**
 * Retrieve a credential for the signed invocation owner.
 * Usage: node get.js --name <credential-name> [--shared]
 */

'use strict';

const {
  fail,
  parseArgs,
  rejectAuthorityArgs,
  emit,
  validateCredentialName,
  requestCredentialOperation,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: get.js --name <credential-name> [--shared]');
    process.exit(0);
  }
  rejectAuthorityArgs(args);
  validateCredentialName(args.name);

  try {
    const result = await requestCredentialOperation({
      operation: 'get',
      name: args.name,
      sharedOnly: args.shared === true,
    });
    emit(result.credential);
  } catch (error) {
    if (error.status === 404) {
      emit({
        error: 'not_found',
        message: `Credential "${args.name}" is not provisioned.`,
      });
      return;
    }
    fail(`Failed to retrieve credential: ${error.message}`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
