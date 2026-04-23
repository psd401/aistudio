#!/usr/bin/env node
/**
 * request_new.js — credentials.request_new
 * Usage: node request_new.js --user <email> --name <name> --reason <reason> [--skill-context <ctx>]
 *
 * Files a credential request in the admin queue (psd_agent_credential_requests
 * table). Does NOT create the credential — an admin must provision it.
 */

'use strict';

const {
  fail,
  validateEnv,
  validateUserEmail,
  parseArgs,
  emit,
  insertCredentialRequest,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: request_new.js --user <email> --name <name> --reason <reason> [--skill-context <ctx>]');
    process.exit(0);
  }
  validateEnv();
  validateUserEmail(args.user);

  if (!args.name) {
    fail('--name is required (desired credential name)');
  }
  if (!args.reason) {
    fail('--reason is required (why this credential is needed)');
  }

  try {
    const requestId = await insertCredentialRequest(
      args.name,
      args.reason,
      args.skill_context || null,
      args.user,
    );

    emit({
      requestId,
      status: 'pending',
      message: `Credential request for "${args.name}" submitted. ` +
        'An administrator will review and provision it. ' +
        'You will be able to use it once provisioned.',
    });
  } catch (err) {
    fail(`Failed to submit credential request: ${err.message}`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
