#!/usr/bin/env node
/**
 * check_capability.js — credentials.check_capability
 * Usage:
 *   node check_capability.js --user <email> --capability <identifier> [--skill-id <uuid>]
 *
 * Returns JSON `{ granted: true|false }` and exits 0 (granted) or 3
 * (denied). Other errors exit 1. Fail-closed on database errors —
 * restricted skills must refuse to run when capability cannot be
 * confirmed.
 *
 * Access is granted when the caller satisfies `--capability` OR (when
 * `--skill-id` is supplied) matches an explicit per-skill access grant —
 * a role or synced-group grant in `resource_access_grants` (Epic #1202
 * Phase 3, #1206). `--skill-id` is optional and additive: omitting it
 * reproduces the pre-#1206 capability-only behavior exactly. At least one
 * of `--capability` / `--skill-id` must be provided.
 *
 * TRUST BOUNDARY: --user is caller-trusted. The harness is expected to
 * inject the authenticated user's email from the verified session and
 * strip any user-supplied overrides. If a prompt-injection or malicious
 * tool output can control --user, a user could gain another user's
 * capability grants. This is an inherent constraint of the CLI-based
 * skill architecture — see psd-credentials/SKILL.md § Security: Trust
 * Boundaries for the full analysis and compensating controls. The same
 * boundary applies to --skill-id (which only widens, never narrows, the
 * caller's own access), so it does not add trust surface.
 */

'use strict';

const {
  fail,
  validateEnv,
  validateUserEmail,
  parseArgs,
  emit,
  userCanAccessSkill,
} = require('./common');

// A skill id is a UUID (psd_agent_skills.id). Validate the shape before it
// reaches SQL (defense-in-depth on top of parameter binding) and to surface a
// clear error for a malformed value rather than a silent no-match.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: check_capability.js --user <email> --capability <identifier> [--skill-id <uuid>]');
    process.exit(0);
  }
  validateEnv();
  validateUserEmail(args.user);

  const hasCapabilityArg = args.capability && args.capability !== true;
  const hasSkillIdArg = args.skill_id && args.skill_id !== true;

  if (!hasCapabilityArg && !hasSkillIdArg) {
    fail('At least one of --capability or --skill-id is required');
  }

  // Format guard: capability identifiers are dot-delimited lowercase tokens
  // (e.g. "skill.image-gen"). Reject empty, overlong, or non-printable values
  // to surface clear errors rather than confusing downstream behavior.
  if (hasCapabilityArg && !/^[a-z0-9._-]{1,64}$/.test(args.capability)) {
    fail(`Invalid capability format: "${args.capability}". ` +
      'Must be 1-64 chars of lowercase alphanumeric, dots, hyphens, underscores.');
  }
  if (hasSkillIdArg && !UUID_RE.test(args.skill_id)) {
    fail(`Invalid skill id format: "${args.skill_id}". Must be a UUID.`);
  }

  const capability = hasCapabilityArg ? args.capability : undefined;
  const skillId = hasSkillIdArg ? args.skill_id : undefined;

  let granted = false;
  try {
    // Capability OR per-skill grant. With no skillId this is exactly the
    // former capability-only path (userCanAccessSkill short-circuits on the
    // capability match and never touches the grant table).
    granted = await userCanAccessSkill(args.user, capability, skillId);
  } catch (err) {
    fail(`Capability check failed: ${err.message}`);
  }

  // Omit user email from output — the caller already knows it, and
  // including PII in tool stdout increases accidental exposure surface.
  emit({ granted, capability: capability ?? null, skillId: skillId ?? null });
  process.exit(granted ? 0 : 3);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
