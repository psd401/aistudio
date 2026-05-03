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
 *
 * TRUST BOUNDARY: --user is caller-trusted. The harness is expected to
 * inject the authenticated user's email from the verified session and
 * strip any user-supplied overrides. If a prompt-injection or malicious
 * tool output can control --user, a user could gain another user's
 * capability grants. This is an inherent constraint of the CLI-based
 * skill architecture — see psd-credentials/SKILL.md § Security: Trust
 * Boundaries for the full analysis and compensating controls.
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
  // Format guard: capability identifiers are dot-delimited lowercase tokens
  // (e.g. "skill.image-gen"). Reject empty, overlong, or non-printable values
  // to surface clear errors rather than confusing downstream behavior.
  if (!/^[a-z0-9._-]{1,64}$/.test(args.capability)) {
    fail(`Invalid capability format: "${args.capability}". ` +
      'Must be 1-64 chars of lowercase alphanumeric, dots, hyphens, underscores.');
  }

  let granted = false;
  try {
    granted = await userHasCapability(args.user, args.capability);
  } catch (err) {
    fail(`Capability check failed: ${err.message}`);
  }

  // Omit user email from output — the caller already knows it, and
  // including PII in tool stdout increases accidental exposure surface.
  emit({ granted, capability: args.capability });
  process.exit(granted ? 0 : 3);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
