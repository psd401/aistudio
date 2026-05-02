#!/usr/bin/env node
/**
 * check_capability.js — credentials.check_capability
 * Usage:
 *   node check_capability.js --user <email> --capability <identifier>
 *
 * Returns JSON `{ granted: true|false }` and exits 0 (granted) or 3
 * (denied). Other errors exit 1. Fail-closed on database errors —
 * restricted skills must refuse to run when capability cannot be
 * confirmed.
 */

'use strict';

const {
  fail,
  validateEnv,
  validateUserEmail,
  parseArgs,
  emit,
  userHasCapability,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: check_capability.js --user <email> --capability <identifier>');
    process.exit(0);
  }
  validateEnv();
  validateUserEmail(args.user);

  if (!args.capability || args.capability === true) {
    fail('--capability is required');
  }

  let granted = false;
  try {
    granted = await userHasCapability(args.user, args.capability);
  } catch (err) {
    fail(`Capability check failed: ${err.message}`);
  }

  emit({ granted, capability: args.capability, user: args.user });
  process.exit(granted ? 0 : 3);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
