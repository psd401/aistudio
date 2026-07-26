/**
 * Credential broker client regression tests.
 *
 * These tests pin the new authority boundary: no credential command accepts a
 * caller-selected owner, and every broker request carries the opaque router
 * context to one fixed app route.
 */

'use strict';

const {
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  mock,
} = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const contextPath = path.join(
  os.tmpdir(),
  `psd-credential-context-${process.pid}`,
);
const contextToken = `v1.${'A'.repeat(40)}.${'B'.repeat(43)}`;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  fs.writeFileSync(contextPath, contextToken, { mode: 0o600 });
  process.env.PSD_INVOCATION_CONTEXT_FILE = contextPath;
  process.env.APP_BASE_URL = 'https://app.example.test/base?ignored=1';
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  fs.unlinkSync(contextPath);
  delete process.env.PSD_INVOCATION_CONTEXT_FILE;
  delete process.env.APP_BASE_URL;
});

beforeEach(() => {
  globalThis.fetch = mock(async () =>
    new Response(
      JSON.stringify({
        granted: true,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
});

test('broker requests use the fixed HTTPS route and signed context', async () => {
  const common = require('./common');
  await common.requestCredentialOperation({
    operation: 'check-skill-access',
    capability: 'skill.image-gen',
  });
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = globalThis.fetch.mock.calls[0];
  expect(String(url)).toBe('https://app.example.test/api/agent/credentials');
  expect(init.redirect).toBe('error');
  expect(init.headers['X-Agent-Invocation-Context']).toBe(contextToken);
  expect(init.headers.Authorization).toBeUndefined();
  expect(JSON.parse(init.body)).toEqual({
    operation: 'check-skill-access',
    capability: 'skill.image-gen',
  });
});

test('broker errors fail closed and preserve no secret response text', async () => {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ error: 'Forbidden', secret: 'do-not-echo' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }));
  const common = require('./common');
  await expect(
    common.requestCredentialOperation({ operation: 'list' }),
  ).rejects.toThrow('Credential broker rejected the request: Forbidden');
});

const CLIS = [
  'get.js',
  'list.js',
  'put.js',
  'request_new.js',
  'check_capability.js',
];

test.each(CLIS)('%s rejects the legacy --user authority selector', (file) => {
  const result = spawnSync(
    'node',
    [path.resolve(__dirname, file), '--user', 'victim@psd401.net'],
    {
      encoding: 'utf8',
      env: process.env,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    '--user is not accepted; identity comes from the signed invocation',
  );
});

test('capability CLI requires a valid capability or skill id', () => {
  const result = spawnSync(
    'node',
    [path.resolve(__dirname, 'check_capability.js')],
    { encoding: 'utf8', env: process.env },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    'At least one of --capability or --skill-id is required',
  );
});
