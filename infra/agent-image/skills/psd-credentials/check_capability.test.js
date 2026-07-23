/**
 * Tests for the #1206 skill access gate: a restricted skill runs when the caller
 * satisfies its `required_capability` OR matches an explicit per-skill
 * resource_access_grant (role/group). Fail-closed on a DB error or misconfig.
 *
 * The RDS Data API transport is stubbed via mock.module so the REAL SQL-building
 * code in common.js runs against controlled `records`; this is the strongest
 * proof possible without an Aurora Data API endpoint (common.js uses the Data
 * API, not the postgres.js driver the local Docker DB speaks — see #1206 notes).
 *
 * A second block spawns check_capability.js as a subprocess to pin the CLI's
 * fail-closed contract: no DB configured => denied (exit 3), missing both gate
 * args => usage error (exit 1), --help => exit 0.
 *
 * Run: bun test infra/agent-image/skills/psd-credentials/check_capability.test.js
 */

'use strict';

// common.js reads these at module-load time to decide whether to build the RDS
// client — set them BEFORE requiring it so rdsClient is non-null and the queries
// actually execute (against the mocked transport below).
process.env.ENVIRONMENT = 'dev';
process.env.AWS_REGION = 'us-east-1';
process.env.DATABASE_RESOURCE_ARN = 'arn:aws:rds:us-east-1:000000000000:cluster:test';
process.env.DATABASE_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:test';

const { test, expect, beforeEach, mock } = require('bun:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Records returned per query kind. Each test sets these to shape the DB reply.
// `records: [[...]]` (non-empty) means "row found"; `[]` means "no row".
let capabilityRecords = [];
let grantRecords = [];
let sqlSeen = [];

mock.module('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: class {
    async send(command) {
      const sql = command?.input?.sql || '';
      sqlSeen.push(sql);
      if (sql.includes('role_capabilities')) return { records: capabilityRecords };
      if (sql.includes('resource_access_grants')) return { records: grantRecords };
      return { records: [] };
    }
  },
  ExecuteStatementCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));

// Require AFTER the mock is registered so common.js binds the stubbed client.
const common = require('./common');

const EMAIL = 'teacher@psd401.net';
const CAP = 'skill.image-gen';
const SKILL_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  capabilityRecords = [];
  grantRecords = [];
  sqlSeen = [];
});

// ── userCanAccessSkill: the capability-OR-grant matrix ─────────────────────────

test('capability match alone grants access (grant table never queried)', async () => {
  capabilityRecords = [[{ longValue: 1 }]];
  grantRecords = []; // irrelevant — must not be consulted
  const ok = await common.userCanAccessSkill(EMAIL, CAP, SKILL_ID);
  expect(ok).toBe(true);
  // Short-circuit: the grant query must NOT have run.
  expect(sqlSeen.some((s) => s.includes('resource_access_grants'))).toBe(false);
});

test('no capability but a matching per-skill grant grants access', async () => {
  capabilityRecords = [];
  grantRecords = [[{ longValue: 1 }]];
  const ok = await common.userCanAccessSkill(EMAIL, CAP, SKILL_ID);
  expect(ok).toBe(true);
  // The grant query DID run (capability missed).
  expect(sqlSeen.some((s) => s.includes('resource_access_grants'))).toBe(true);
});

test('neither capability nor grant => denied', async () => {
  capabilityRecords = [];
  grantRecords = [];
  expect(await common.userCanAccessSkill(EMAIL, CAP, SKILL_ID)).toBe(false);
});

test('grant match with NO capability arg (grant is the sole gate)', async () => {
  grantRecords = [[{ longValue: 1 }]];
  expect(await common.userCanAccessSkill(EMAIL, undefined, SKILL_ID)).toBe(true);
});

test('capability-only call with NO skillId reproduces prior behavior', async () => {
  capabilityRecords = [[{ longValue: 1 }]];
  expect(await common.userCanAccessSkill(EMAIL, CAP, undefined)).toBe(true);
  // Grant table must not be touched when no skillId is supplied.
  expect(sqlSeen.some((s) => s.includes('resource_access_grants'))).toBe(false);
});

test('both gate args omitted => denied (no query)', async () => {
  expect(await common.userCanAccessSkill(EMAIL, undefined, undefined)).toBe(false);
  expect(sqlSeen.length).toBe(0);
});

// ── userMatchesResourceGrant: explicit-match-only semantics ────────────────────

test('userMatchesResourceGrant returns false with zero grant rows (NOT unrestricted)', async () => {
  grantRecords = [];
  expect(await common.userMatchesResourceGrant(EMAIL, 'skill', SKILL_ID)).toBe(false);
});

test('userMatchesResourceGrant returns true on an explicit match', async () => {
  grantRecords = [[{ longValue: 1 }]];
  expect(await common.userMatchesResourceGrant(EMAIL, 'skill', SKILL_ID)).toBe(true);
});

test('userMatchesResourceGrant guards missing args (fail-closed)', async () => {
  expect(await common.userMatchesResourceGrant('', 'skill', SKILL_ID)).toBe(false);
  expect(await common.userMatchesResourceGrant(EMAIL, 'skill', null)).toBe(false);
  expect(await common.userMatchesResourceGrant(EMAIL, 'skill', undefined)).toBe(false);
});

// ── CLI exit-code contract (subprocess, no DB configured => fail-closed) ───────

const CLI = path.resolve(__dirname, 'check_capability.js');

function runCli(args, env = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    // Strip the DB ARNs so rdsClient is null => every check fails closed.
    env: { ...process.env, DATABASE_RESOURCE_ARN: '', DATABASE_SECRET_ARN: '', ...env },
  });
}

test('CLI: --help exits 0', () => {
  const r = runCli(['--help']);
  expect(r.status).toBe(0);
});

test('CLI: valid args but unconfigured DB => denied (exit 3)', () => {
  const r = runCli(['--user', EMAIL, '--capability', CAP, '--skill-id', SKILL_ID]);
  expect(r.status).toBe(3);
  expect(r.stdout).toContain('"granted":false');
});

test('CLI: neither --capability nor --skill-id => usage error (exit 1)', () => {
  const r = runCli(['--user', EMAIL]);
  expect(r.status).toBe(1);
});

test('CLI: malformed --skill-id => error (exit 1)', () => {
  const r = runCli(['--user', EMAIL, '--capability', CAP, '--skill-id', 'not-a-uuid']);
  expect(r.status).toBe(1);
});

test('CLI: invalid email => error (exit 1)', () => {
  const r = runCli(['--user', 'not-an-email', '--capability', CAP]);
  expect(r.status).toBe(1);
});
