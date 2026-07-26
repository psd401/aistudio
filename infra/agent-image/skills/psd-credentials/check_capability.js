#!/usr/bin/env node
/**
 * Check a capability or skill grant for the signed invocation owner.
 * Usage: node check_capability.js --capability <identifier>
 *   [--skill-id <uuid>]
 */

'use strict';

const {
  fail,
  parseArgs,
  rejectAuthorityArgs,
  emit,
  requestCredentialOperation,
} = require('./common');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: check_capability.js --capability <identifier> [--skill-id <uuid>]');
    process.exit(0);
  }
  rejectAuthorityArgs(args);
  const capability =
    typeof args.capability === 'string' ? args.capability : undefined;
  const skillId =
    typeof args.skill_id === 'string' ? args.skill_id : undefined;
  if (!capability && !skillId) {
    fail('At least one of --capability or --skill-id is required');
  }
  if (capability && !/^[a-z0-9._-]{1,64}$/.test(capability)) {
    fail('Invalid capability format');
  }
  if (skillId && !UUID_RE.test(skillId)) {
    fail('Invalid skill id format');
  }

  try {
    const result = await requestCredentialOperation({
      operation: 'check-skill-access',
      capability,
      skillId,
    });
    emit({ granted: result.granted, capability: capability ?? null, skillId: skillId ?? null });
    process.exit(result.granted ? 0 : 3);
  } catch (error) {
    fail(`Capability check failed: ${error.message}`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
