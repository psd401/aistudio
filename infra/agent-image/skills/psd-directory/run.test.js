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

  test('an untyped broker 5xx is retryable 12, not 2 (codex P2)', () => {
    // Failures BELOW the route — the local relay's own 502/503, or a
    // mint-boundary error the route could not classify — arrive with no typed
    // status. Mapping those to 2 ("do not retry blindly") presents a
    // transient proxy or Lambda blip as a permanent lookup failure.
    expect(exitCodeForStatus(null, 502)).toBe(12);
    expect(exitCodeForStatus(null, 503)).toBe(12);
    expect(exitCodeForStatus(undefined, 500)).toBe(12);
  });

  test('a typed permanent failure is NOT upgraded to retryable by its HTTP code', () => {
    // The route returns LOOKUP_FAILED and FORBIDDEN with HTTP 502, so keying
    // off the status code alone would advertise a People API 400 as a
    // transient outage. A typed status is a definite answer from the route.
    expect(exitCodeForStatus('LOOKUP_FAILED', 502)).toBe(2);
    expect(exitCodeForStatus('FORBIDDEN', 502)).toBe(2);
    expect(exitCodeForStatus('some-future-status', 503)).toBe(2);
  });

  test('an untyped 4xx stays 2 — a bad request is not retryable', () => {
    expect(exitCodeForStatus(null, 400)).toBe(2);
    expect(exitCodeForStatus(null, 403)).toBe(2);
  });

  test('a typed status still wins over the HTTP status', () => {
    // A 409 carrying DIRECTORY_SHARING_DISABLED must keep its own code.
    expect(exitCodeForStatus('DIRECTORY_SHARING_DISABLED', 409)).toBe(16);
    expect(exitCodeForStatus('account-not-provisioned', 409)).toBe(14);
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

describe('output shape', () => {
  const src = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');

  test('emits cached:false explicitly on a fresh result', () => {
    // The server omits `cached` entirely on a miss and sets it true only on a
    // hit, so emitting its result verbatim would drop the field that SKILL.md
    // documents. Callers use it to tell a fresh answer from a malformed or
    // legacy response.
    expect(src).toContain('emit({ cached: false, ...result })');
  });

  test('a cache hit still reports cached:true', () => {
    // The spread must come AFTER the default, or every hit would report false.
    const emitLine = src.match(/emit\(\{[^}]*\.\.\.result[^}]*\}\)/);
    expect(emitLine).not.toBeNull();
    expect(emitLine[0].indexOf('cached: false')).toBeLessThan(
      emitLine[0].indexOf('...result')
    );
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
