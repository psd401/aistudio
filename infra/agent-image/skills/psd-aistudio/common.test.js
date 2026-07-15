/**
 * Unit tests for psd-aistudio common.js — the #1223 key-resolution + MCP boundary.
 *
 * Covers:
 *   1. resolveApiKey prefers the caller's PERSONAL key (override) over the shared
 *      key, and never leaks the value to stdout/stderr (only the source label).
 *   2. resolveApiKey falls back to the SHARED platform:read key when no personal
 *      key is stored, when no caller email is given, or when the per-user store is
 *      unreachable — and maps empty/failed shared-secret reads to exit 11 / 12.
 *   3. callMcpRaw sends the Bearer key + mcp-protocol-version header, returns the
 *      result on success, and returns (does NOT emit/exit for) a JSON-RPC error.
 *   4. callMcp (back-compat wrapper) writes the result to stdout on success and
 *      maps JSON-RPC error → exit 12, 401 → exit 11, 429 → exit 14.
 *   5. unwrapResult parses the MCP text envelope + isError; callTool returns the
 *      unwrapped payload / passes a JSON-RPC error through.
 *
 * NOTE: fake key values here deliberately DO NOT use the `sk-` prefix, so no
 * literal `sk-` value ever appears in this test (issue #1223 DoD).
 */

'use strict';

// common.js reads these at module-load time — set them BEFORE requiring it.
process.env.AISTUDIO_MCP_URL = 'https://app.test/api/mcp';
process.env.AISTUDIO_MCP_API_KEY = ''; // force the shared SECRET path for fallback
process.env.AISTUDIO_MCP_API_KEY_SECRET_ID = 'psd-agent/dev/aistudio-mcp-api-key';

const { test, expect, beforeEach, afterEach, mock } = require('bun:test');

const { secretsStore } = require('./test-support');
const common = require('./common');

// Stub the psd-credentials subprocess via common's injectable seam (bun's
// mock.module cannot intercept the `node:child_process` builtin).
function setExecFileSync(fn) {
  common._internals.execFileSync = fn;
}

const KEY_SECRET_ID = 'psd-agent/dev/aistudio-mcp-api-key';
const EMAIL = 'teacher@psd401.net';
// Non-`sk-` placeholders so no literal sk- value appears anywhere.
const PERSONAL = 'PERSONALKEYVALUE';
const SHARED = 'SHAREDKEYVALUE';

class ExitError extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

let stdoutLines;
let stderrLines;
let originalFetch;
let originalExit;
let originalStdoutWrite;
let originalStderrWrite;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stdoutText() {
  return stdoutLines.join('');
}
function stderrText() {
  return stderrLines.join('');
}
/** The last JSON object written to stdout (emit / callMcp result write). */
function lastStdoutJson() {
  const nonEmpty = stdoutLines.filter((l) => l.trim().length > 0);
  const line = nonEmpty[nonEmpty.length - 1];
  return line ? JSON.parse(line) : undefined;
}

beforeEach(() => {
  for (const key of Object.keys(secretsStore)) delete secretsStore[key];
  // Default: any accidental subprocess call fails loudly. Tests that exercise the
  // personal-key path set an explicit implementation.
  setExecFileSync(() => {
    throw new Error('execFileSync not stubbed for this test');
  });
  stdoutLines = [];
  stderrLines = [];
  originalFetch = globalThis.fetch;
  originalExit = process.exit;
  originalStdoutWrite = process.stdout.write;
  originalStderrWrite = process.stderr.write;
  process.exit = (code) => {
    throw new ExitError(code);
  };
  process.stdout.write = (s) => {
    stdoutLines.push(String(s));
    return true;
  };
  process.stderr.write = (s) => {
    stderrLines.push(String(s));
    return true;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

// ── resolveApiKey: personal override vs shared fallback ────────────────────────

test('resolveApiKey prefers the caller PERSONAL key over the shared key (override)', async () => {
  setExecFileSync(
    () =>
      JSON.stringify({ name: 'aistudio_personal_key', value: PERSONAL, scope: 'user' }) +
      '\n'
  );
  secretsStore[KEY_SECRET_ID] = SHARED; // must NOT be used

  const r = await common.resolveApiKey(EMAIL);

  expect(r.source).toBe('personal');
  expect(r.key).toBe(PERSONAL);
  // Only the SOURCE label reaches stderr — never the value; stdout stays empty.
  expect(stderrText().toLowerCase()).toContain('personal');
  expect(stderrText()).not.toContain(PERSONAL);
  expect(stdoutText()).not.toContain(PERSONAL);
});

test('resolveApiKey falls back to the SHARED key when no personal key is stored', async () => {
  setExecFileSync(() => JSON.stringify({ error: 'not_found', message: 'x' }) + '\n');
  secretsStore[KEY_SECRET_ID] = SHARED;

  const r = await common.resolveApiKey(EMAIL);

  expect(r.source).toBe('shared');
  expect(r.key).toBe(SHARED);
  expect(stderrText()).toContain('platform:read');
});

test('resolveApiKey uses the shared key when no caller email is given (no subprocess)', async () => {
  let called = false;
  setExecFileSync(() => {
    called = true;
    return '';
  });
  secretsStore[KEY_SECRET_ID] = SHARED;

  const r = await common.resolveApiKey(undefined);

  expect(r.source).toBe('shared');
  expect(r.key).toBe(SHARED);
  expect(called).toBe(false);
});

test('resolveApiKey degrades to the shared key when the per-user store is unreachable', async () => {
  setExecFileSync(() => {
    throw new Error('get.js exited 1');
  });
  secretsStore[KEY_SECRET_ID] = SHARED;

  const r = await common.resolveApiKey(EMAIL);

  expect(r.source).toBe('shared');
  expect(r.key).toBe(SHARED);
});

test('resolveApiKey ignores a SHARED-scope secret stored under the personal-key name', async () => {
  // get.js falls back to the shared namespace for the same credential name; a
  // same-named shared secret is NOT the caller's personal key and must not be
  // labeled `personal` (wrong stderr + wrong re-mint hint downstream).
  setExecFileSync(
    () =>
      JSON.stringify({
        name: 'aistudio_personal_key',
        value: 'SHAREDSCOPEVALUE',
        scope: 'shared',
      }) + '\n'
  );
  secretsStore[KEY_SECRET_ID] = SHARED;

  const r = await common.resolveApiKey(EMAIL);

  expect(r.source).toBe('shared');
  expect(r.key).toBe(SHARED);
  expect(stderrText()).not.toContain('SHAREDSCOPEVALUE');
});

test('resolveApiKey failure notice never echoes the caller email (argv echo)', async () => {
  // execFileSync's default err.message is "Command failed: node get.js --user
  // <email> ..." — the notice must report only the exit status, not the argv.
  setExecFileSync(() => {
    const e = new Error(
      `Command failed: node get.js --user ${EMAIL} --name aistudio_personal_key`
    );
    e.status = 1;
    throw e;
  });
  secretsStore[KEY_SECRET_ID] = SHARED;

  const r = await common.resolveApiKey(EMAIL);

  expect(r.source).toBe('shared');
  expect(stderrText()).not.toContain(EMAIL);
});

test('resolveApiKey exits 11 when the shared secret is present but empty', async () => {
  secretsStore[KEY_SECRET_ID] = '';
  let code;
  try {
    await common.resolveApiKey(undefined);
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(11);
});

test('resolveApiKey exits 12 when the shared-secret fetch fails (secret missing)', async () => {
  delete secretsStore[KEY_SECRET_ID];
  let code;
  try {
    await common.resolveApiKey(undefined);
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(12);
});

// ── callMcpRaw ─────────────────────────────────────────────────────────────────

test('callMcpRaw sends the Bearer key + mcp-protocol-version and returns the result', async () => {
  secretsStore[KEY_SECRET_ID] = SHARED;
  let seen;
  globalThis.fetch = mock(async (url, init) => {
    seen = { url: String(url), init };
    return jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"ok":true}' }] },
    });
  });

  const out = await common.callMcpRaw('tools/list', {}, undefined);

  expect(seen.url).toBe('https://app.test/api/mcp');
  expect(seen.init.method).toBe('POST');
  expect(seen.init.headers.Authorization).toBe(`Bearer ${SHARED}`);
  expect(seen.init.headers['mcp-protocol-version']).toBe('2024-11-05');
  expect(out.keySource).toBe('shared');
  expect(out.result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
});

test('callMcpRaw uses the caller personal key when stored', async () => {
  setExecFileSync(() => JSON.stringify({ value: PERSONAL, scope: 'user' }) + '\n');
  secretsStore[KEY_SECRET_ID] = SHARED;
  let seen;
  globalThis.fetch = mock(async (url, init) => {
    seen = init;
    return jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  const out = await common.callMcpRaw('tools/list', {}, EMAIL);

  expect(seen.headers.Authorization).toBe(`Bearer ${PERSONAL}`);
  expect(out.keySource).toBe('personal');
});

test('callMcpRaw returns a JSON-RPC error WITHOUT emitting or exiting', async () => {
  secretsStore[KEY_SECRET_ID] = SHARED;
  globalThis.fetch = mock(async () =>
    jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Insufficient scope for tool: execute_assistant' },
    })
  );

  const out = await common.callMcpRaw('tools/call', { name: 'execute_assistant' }, undefined);

  expect(out.jsonrpcError.message).toContain('Insufficient scope');
  expect(out.httpStatus).toBe(200);
  expect(out.keySource).toBe('shared');
  expect(stdoutText()).toBe(''); // nothing emitted
});

test('callMcpRaw fails (exit 12) on HTTP 200 without a result or error field', async () => {
  // Malformed JSON-RPC envelope (proxy/gateway corruption) — must not be
  // emitted as a successful `null` result.
  secretsStore[KEY_SECRET_ID] = SHARED;
  globalThis.fetch = mock(async () => jsonResponse({ jsonrpc: '2.0', id: 1 }));

  let code;
  try {
    await common.callMcpRaw('tools/list', {}, undefined);
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(12);
  expect(stdoutText()).toBe('');
});

test('execute_assistant waits past the 900s server ceiling; other tools use the default', () => {
  // /api/mcp and the v1 execute route declare maxDuration = 900 — a shorter
  // client timeout would abort legitimate long assistant executions locally.
  expect(common.timeoutForTool('execute_assistant')).toBe(common.MCP_EXECUTE_TIMEOUT_MS);
  expect(common.MCP_EXECUTE_TIMEOUT_MS).toBeGreaterThan(900_000);
  expect(common.timeoutForTool('list_assistants')).toBe(common.MCP_FETCH_TIMEOUT_MS);
  expect(common.timeoutForTool('capture_decision')).toBe(common.MCP_FETCH_TIMEOUT_MS);
});

test('callMcpRaw maps a fetch timeout to a clean exit 12', async () => {
  secretsStore[KEY_SECRET_ID] = SHARED;
  globalThis.fetch = mock(async () => {
    const e = new Error('The operation timed out');
    e.name = 'TimeoutError';
    throw e;
  });

  let code;
  try {
    await common.callMcpRaw('tools/list', {}, undefined);
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(12);
  expect(stderrText()).toContain('did not respond within');
});

// ── callMcp (back-compat wrapper for capabilities/list) ────────────────────────

test('callMcp writes the result to stdout on success (back-compat)', async () => {
  secretsStore[KEY_SECRET_ID] = SHARED;
  globalThis.fetch = mock(async () =>
    jsonResponse({ jsonrpc: '2.0', id: 1, result: { hello: 'world' } })
  );

  const r = await common.callMcp('tools/list', {}, undefined);

  expect(r).toEqual({ hello: 'world' });
  expect(lastStdoutJson()).toEqual({ hello: 'world' });
});

test('callMcp emits mcp-error and exits 12 on a JSON-RPC error (back-compat)', async () => {
  secretsStore[KEY_SECRET_ID] = SHARED;
  globalThis.fetch = mock(async () =>
    jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Insufficient scope' } })
  );

  let code;
  try {
    await common.callMcp('tools/call', {}, undefined);
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(12);
  expect(lastStdoutJson().status).toBe('mcp-error');
});

test('callMcp maps 401 to exit 11', async () => {
  secretsStore[KEY_SECRET_ID] = SHARED;
  globalThis.fetch = mock(async () => jsonResponse({ error: 'nope' }, 401));

  let code;
  try {
    await common.callMcp('tools/list', {}, undefined);
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(11);
  expect(lastStdoutJson().status).toBe('unauthorized');
});

test('callMcp maps 429 to exit 14', async () => {
  secretsStore[KEY_SECRET_ID] = SHARED;
  globalThis.fetch = mock(async () => jsonResponse({}, 429));

  let code;
  try {
    await common.callMcp('tools/list', {}, undefined);
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(14);
  expect(lastStdoutJson().status).toBe('rate-limited');
});

// ── unwrapResult + callTool ────────────────────────────────────────────────────

test('unwrapResult parses the JSON text payload and reads isError', () => {
  expect(common.unwrapResult({ content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({
    isError: false,
    data: { a: 1 },
  });
  expect(
    common.unwrapResult({ content: [{ type: 'text', text: 'oops' }], isError: true })
  ).toEqual({ isError: true, data: 'oops' });
  expect(common.unwrapResult({ foo: 'bar' })).toEqual({ isError: false, data: { foo: 'bar' } });
});

test('callTool returns the unwrapped payload on success', async () => {
  secretsStore[KEY_SECRET_ID] = SHARED;
  globalThis.fetch = mock(async () =>
    jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"assistants":[]}' }] },
    })
  );

  const res = await common.callTool('list_assistants', {}, undefined);

  expect(res.isError).toBe(false);
  expect(res.payload).toEqual({ assistants: [] });
  expect(res.keySource).toBe('shared');
});

test('callTool passes a JSON-RPC error through (no emit/exit)', async () => {
  secretsStore[KEY_SECRET_ID] = SHARED;
  globalThis.fetch = mock(async () =>
    jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Insufficient scope for tool: capture_decision' },
    })
  );

  const res = await common.callTool('capture_decision', {}, undefined);

  expect(res.jsonrpcError.message).toContain('Insufficient scope');
  expect(res.keySource).toBe('shared');
  expect(stdoutText()).toBe('');
});

test('callTool surfaces a tool-level isError result as { isError:true, payload }', async () => {
  secretsStore[KEY_SECRET_ID] = SHARED;
  globalThis.fetch = mock(async () =>
    jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: 'Assistant execution failed: Record not found in assistant_architects with id: 7',
          },
        ],
        isError: true,
      },
    })
  );

  const res = await common.callTool('execute_assistant', { assistantId: 7 }, undefined);

  expect(res.isError).toBe(true);
  expect(res.payload).toContain('Record not found');
});
