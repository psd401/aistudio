#!/usr/bin/env node
/**
 * get.js — credentials.get
 * Usage: node get.js --user <email> --name <credential-name>
 *
 * Retrieves a credential value from AWS Secrets Manager. Checks
 * user-scoped first, then shared. Logs the read to telemetry
 * (name only, never value).
 */

'use strict';

const {
  fail,
  validateEnv,
  validateUserEmail,
  parseArgs,
  emit,
  getCredential,
  logCredentialRead,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: get.js --user <email> --name <credential-name>');
    process.exit(0);
  }
  validateEnv();
  validateUserEmail(args.user);

  if (!args.name) {
    fail('--name is required (credential name to retrieve)');
  }

  try {
    const result = await getCredential(args.name, args.user);

    if (!result) {
      emit({
        error: 'not_found',
        message: `Credential "${args.name}" not found. It may not be provisioned yet. ` +
          'Use request_new to ask an admin to create it.',
      });
      process.exit(0);
    }

    // Log the read to telemetry (best-effort, never blocks)
    await logCredentialRead(args.name, args.user, process.env.SESSION_ID || '').catch((err) => {
      console.error(`Telemetry log failed (non-fatal): ${err.message}`);
    });

    emit({ name: result.name, value: result.value, scope: result.scope });
  } catch (err) {
    fail(`Failed to retrieve credential: ${err.message}`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
