#!/usr/bin/env node
/**
 * Store a credential for the signed invocation owner.
 * Usage: node put.js --name <credential-name> --value <secret-value>
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
    console.log('Usage: put.js --name <credential-name> --value <secret-value>');
    process.exit(0);
  }
  rejectAuthorityArgs(args);
  validateCredentialName(args.name);
  if (typeof args.value !== 'string') {
    fail('--value is required (the secret value to store)');
  }

  try {
    const result = await requestCredentialOperation({
      operation: 'put',
      name: args.name,
      value: args.value,
    });
    emit({
      ...result.credential,
      scope: 'user',
      message: `Credential "${result.credential.name}" ${result.credential.action}.`,
    });
  } catch (error) {
    fail(`Failed to store credential: ${error.message}`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
