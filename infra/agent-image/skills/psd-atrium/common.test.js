/**
 * Unit tests for psd-atrium common.js — the auth + REST boundary.
 *
 * Covers:
 *   1. resolveContentBaseUrl honors the explicit AISTUDIO_CONTENT_API_URL override.
 *   2. restFetch reads the sk- content key from Secrets Manager and sends it as a
 *      Bearer token, unwrapping the v1 { data } envelope on success.
 *   3. restFetch serializes the query object and drops empty values.
 *   4. restFetch treats HTTP 202 as a (non-error) approval_required outcome.
 *   5. restFetch maps 401 → exit 11, a 4xx error envelope → exit 12, 429 → exit 14.
 *   6. parseList / parseGrants parse the list + group-grant flag shapes.
 *
 * Secrets Manager is stubbed via test-support; fetch is stubbed per-test;
 * process.exit is stubbed to throw so the error-mapping paths are observable
 * without killing the test runner.
 */

'use strict';

// common.js reads these at module-load time — set them BEFORE requiring it.
process.env.AISTUDIO_CONTENT_API_URL = 'https://app.test/api/v1/content';
process.env.AISTUDIO_CONTENT_API_KEY = '';
process.env.AISTUDIO_CONTENT_API_KEY_SECRET_ID = 'psd-agent/dev/atrium-content-api-key';
process.env.APP_BASE_URL = '';

const { test, expect, beforeEach, afterEach, mock } = require('bun:test');

const { secretsStore } = require('./test-support');
const common = require('./common');

const KEY_SECRET_ID = 'psd-agent/dev/atrium-content-api-key';

class ExitError extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

let stdoutLines;
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

/** The last JSON object written to stdout via emit(). */
function lastEmitted() {
  const line = stdoutLines[stdoutLines.length - 1];
  return line ? JSON.parse(line) : undefined;
}

beforeEach(() => {
  for (const key of Object.keys(secretsStore)) delete secretsStore[key];
  secretsStore[KEY_SECRET_ID] = 'sk-testkey';
  stdoutLines = [];
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
  process.stderr.write = () => true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

test('resolveContentBaseUrl honors the explicit override', () => {
  expect(common.resolveContentBaseUrl()).toBe('https://app.test/api/v1/content');
});

test('restFetch sends the Bearer content key and unwraps the v1 data envelope', async () => {
  let seen;
  globalThis.fetch = mock(async (url, init) => {
    seen = { url: String(url), init };
    return jsonResponse({ data: { id: 'obj-1', title: 'Doc' }, meta: {} }, 200);
  });

  const result = await common.restFetch('GET', '/obj-1');

  expect(seen.url).toBe('https://app.test/api/v1/content/obj-1');
  expect(seen.init.method).toBe('GET');
  expect(seen.init.headers.Authorization).toBe('Bearer sk-testkey');
  expect(result).toEqual({
    approvalRequired: false,
    status: 200,
    payload: { id: 'obj-1', title: 'Doc' },
  });
});

test('restFetch serializes the query object and drops empty values', async () => {
  let seen;
  globalThis.fetch = mock(async (url) => {
    seen = String(url);
    return jsonResponse({ data: [], meta: { count: 0 } }, 200);
  });

  await common.restFetch('GET', '', {
    query: { kind: 'document', query: 'trip', tag: undefined, status: '' },
  });

  const parsed = new URL(seen);
  expect(parsed.searchParams.get('kind')).toBe('document');
  expect(parsed.searchParams.get('query')).toBe('trip');
  expect(parsed.searchParams.has('tag')).toBe(false);
  expect(parsed.searchParams.has('status')).toBe(false);
});

test('restFetch POSTs a JSON body with the content-type header', async () => {
  let seen;
  globalThis.fetch = mock(async (url, init) => {
    seen = init;
    return jsonResponse({ data: { id: 'v1' }, meta: {} }, 201);
  });

  const result = await common.restFetch('POST', '/obj-1/versions', {
    body: { body: 'hello', summary: 's' },
  });

  expect(seen.method).toBe('POST');
  expect(seen.headers['Content-Type']).toBe('application/json');
  expect(JSON.parse(seen.body)).toEqual({ body: 'hello', summary: 's' });
  expect(result.status).toBe(201);
  expect(result.payload).toEqual({ id: 'v1' });
});

test('restFetch treats HTTP 202 as an approval_required outcome (not an error)', async () => {
  globalThis.fetch = mock(async () =>
    jsonResponse(
      { data: { status: 'approval_required', message: 'Queued for admin approval.' }, meta: {} },
      202
    )
  );

  const result = await common.restFetch('POST', '/obj-1/publish', {
    body: { destination: 'public_web' },
  });

  expect(result.approvalRequired).toBe(true);
  expect(result.status).toBe(202);
  expect(result.payload).toEqual({
    status: 'approval_required',
    message: 'Queued for admin approval.',
  });
});

test('restFetch maps 401 to exit 11 and emits an unauthorized message', async () => {
  globalThis.fetch = mock(async () => jsonResponse({ error: 'nope' }, 401));

  let code;
  try {
    await common.restFetch('GET', '/obj-1');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(11);
  expect(lastEmitted().status).toBe('unauthorized');
});

test('restFetch maps a 4xx error envelope to exit 12 with the code + message', async () => {
  globalThis.fetch = mock(async () =>
    jsonResponse({ error: { code: 'FORBIDDEN', message: 'You cannot edit this' }, requestId: 'r' }, 403)
  );

  let code;
  try {
    await common.restFetch('POST', '/obj-1/versions', { body: { body: 'x' } });
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(12);
  const emitted = lastEmitted();
  expect(emitted.status).toBe('error');
  expect(emitted.http_status).toBe(403);
  expect(emitted.code).toBe('FORBIDDEN');
  expect(emitted.message).toBe('You cannot edit this');
});

test('restFetch maps 429 to exit 14', async () => {
  globalThis.fetch = mock(async () => jsonResponse({}, 429));

  let code;
  try {
    await common.restFetch('GET', '');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(14);
  expect(lastEmitted().status).toBe('rate-limited');
});

test('parseList splits comma lists and drops empties; undefined when absent', () => {
  expect(common.parseList('a, b ,c,')).toEqual(['a', 'b', 'c']);
  expect(common.parseList(undefined)).toBeUndefined();
});

test('parseList rejects a value-less flag (exit 1) instead of silently dropping it', () => {
  let code;
  try {
    common.parseList(true, 'tags');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('parseGrants parses kind:value pairs', () => {
  expect(common.parseGrants('role:staff,building:GHS')).toEqual([
    { kind: 'role', value: 'staff' },
    { kind: 'building', value: 'GHS' },
  ]);
  expect(common.parseGrants(undefined)).toBeUndefined();
});

test('parseGrants rejects a malformed entry (exit 1)', () => {
  let code;
  try {
    common.parseGrants('bogus');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('parseGrants rejects a value-less flag (exit 1)', () => {
  let code;
  try {
    common.parseGrants(true, 'grants');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('restFetch maps a request timeout to exit 12', async () => {
  globalThis.fetch = mock(async () => {
    const err = new Error('The operation timed out.');
    err.name = 'TimeoutError';
    throw err;
  });

  let code;
  try {
    await common.restFetch('GET', '/obj-1');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(12);
});

test('resolveApiKey exits 12 when the Secrets Manager fetch fails (secret missing)', async () => {
  // The secret id is configured (module env) but absent from the store → the
  // fake GetSecretValueCommand throws → retrieval failure surfaces as exit 12.
  delete secretsStore[KEY_SECRET_ID];
  let code;
  try {
    await common.resolveApiKey();
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(12);
});

test('resolveApiKey exits 11 when the secret is present but empty', async () => {
  secretsStore[KEY_SECRET_ID] = '';
  let code;
  try {
    await common.resolveApiKey();
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(11);
});
