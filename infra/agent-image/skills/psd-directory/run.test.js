/**
 * psd-directory skill tests (#1239).
 *
 * The People API logic now lives server-side in
 * lib/agent-workspace/directory-lookup.ts (see that file's jest suite) —
 * #1353 established that the model runtime never holds a Google token, so the
 * container half is a thin broker client. What remains worth pinning here is
 * the status -> exit-code mapping, because those codes are the skill's
 * contract with the model and SKILL.md documents them individually.
 *
 * Run: bun test run.test.js  (or `bun run test:skill:directory`)
 */

'use strict';

const { test, expect, describe } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { exitCodeForStatus, parseArgs } = require('./run');

describe('status -> exit code', () => {
  test('each documented status maps to its own code', () => {
    expect(exitCodeForStatus('account-not-provisioned')).toBe(14);
    expect(exitCodeForStatus('TRANSPORT')).toBe(12);
    expect(exitCodeForStatus('INVALID_INPUT')).toBe(1);
    expect(exitCodeForStatus('INSUFFICIENT_SCOPE')).toBe(17);
  });

  test('the admin-console state keeps its OWN code', () => {
    // 16 exists so an operator is told to change a Workspace setting rather
    // than hunting a permissions bug. Collapsing it into a generic failure is
    // what made #1239 expensive to diagnose the first time.
    expect(exitCodeForStatus('DIRECTORY_SHARING_DISABLED')).toBe(16);
    expect(exitCodeForStatus('DIRECTORY_SHARING_DISABLED')).not.toBe(
      exitCodeForStatus('INSUFFICIENT_SCOPE')
    );
  });

  test('an unknown or missing status falls back to 2, never 0', () => {
    // A failure must never be reported as success — exit 0 is reserved for a
    // real answer, including a found:false miss.
    for (const s of ['something-new', '', null, undefined]) {
      expect(exitCodeForStatus(s)).toBe(2);
    }
  });
});

describe('argv parsing', () => {
  test('reads --email, --chat-id and --no-cache', () => {
    expect(parseArgs(['n', 'r', '--email', 'a@psd401.net']).email).toBe('a@psd401.net');
    expect(parseArgs(['n', 'r', '--chat-id', 'users/1']).chat_id).toBe('users/1');
    expect(parseArgs(['n', 'r', '--no-cache']).no_cache).toBe(true);
  });
});

describe('security posture', () => {
  const src = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  test('never reads a caller-supplied owner — identity comes from the signed context', () => {
    // #1353 removed model-asserted identity. Reading a `--user` here would let
    // the model choose whose directory access it borrows. Asserted on the
    // BEHAVIOUR (is the arg ever read, does it reach the payload) rather than
    // on the string, because USAGE legitimately says "there is no --user flag".
    expect(code).not.toMatch(/args\.user\b/);
    expect(code).not.toMatch(/ownerEmail/);
    // The request body carries only the selector and the cache flag.
    const payloadKeys = code.match(/payload\.\w+|\{ email:|\{ chatId:/g) || [];
    for (const k of payloadKeys) {
      expect(k).toMatch(/payload\.noCache|\{ email:|\{ chatId:/);
    }
  });

  test('never mints or handles a Google token in the container', () => {
    // The whole point of routing through the broker: no token reaches the
    // model runtime.
    expect(code).not.toContain('fetchBrokerToken');
    expect(code).not.toContain('accessToken');
    expect(code).not.toContain('people.googleapis.com');
  });

  test('calls only the allowlisted directory route', () => {
    expect(code).toContain("requestAgentBroker('/api/agent/directory-lookup'");
  });
});

describe('broker route allowlists stay in sync', () => {
  // The route must be present in BOTH allowlists or the call 404s at the
  // proxy: the skill-side helper and the python relay each gate it
  // independently.
  test('the JS helper allows the directory route', () => {
    const helper = fs.readFileSync(path.join(__dirname, '..', '_shared', 'agent-broker.js'), 'utf8');
    expect(helper).toContain("'/api/agent/directory-lookup'");
  });

  test('the mantle proxy allows the directory route', () => {
    const proxy = fs.readFileSync(
      path.join(__dirname, '..', '..', 'mantle_proxy.py'),
      'utf8'
    );
    expect(proxy).toContain('"/api/agent/directory-lookup"');
  });
});
