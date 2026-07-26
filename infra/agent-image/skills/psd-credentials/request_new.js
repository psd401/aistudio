#!/usr/bin/env node
/**
 * Request a credential for the signed invocation owner.
 * Usage: node request_new.js --name <name> --reason <reason>
 *   [--skill-context <context>]
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
    console.log('Usage: request_new.js --name <name> --reason <reason> [--skill-context <context>]');
    process.exit(0);
  }
  rejectAuthorityArgs(args);
  validateCredentialName(args.name);
  if (typeof args.reason !== 'string' || args.reason.length === 0) {
    fail('--reason is required (why this credential is needed)');
  }

  try {
    const result = await requestCredentialOperation({
      operation: 'request',
      name: args.name,
      reason: args.reason,
      skillContext:
        typeof args.skill_context === 'string' ? args.skill_context : null,
    });
    emit({
      requestId: result.requestId,
      status: 'pending',
      message: `Credential request for "${args.name}" submitted for administrator review.`,
    });
  } catch (error) {
    fail(`Failed to submit credential request: ${error.message}`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
