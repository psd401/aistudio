/**
 * Regression tests for run.js's CLI subcommand → Canva REST wiring.
 *
 * Confirms each subcommand hits the correct method + path + body:
 *   whoami        → GET  /v1/users/me (+ /v1/users/me/profile enrichment)
 *   list-designs  → GET  /v1/designs  (query/ownership/sort_by/continuation)
 *   create-design → POST /v1/designs  (preset vs custom design_type)
 *   export        → startAndPollJob /v1/exports  (format object)
 *   upload-asset  → POST /v1/asset-uploads (binary body + metadata header)
 *
 * common.js's authorizeUser/canvaFetch/startAndPollJob are overridden on the
 * shared module.exports object BEFORE run.js is required, so run.js's top-level
 * destructure captures the stubs instead of hitting the network/Secrets
 * Manager. The AWS SDK is mocked (test-support) so requiring common.js at module
 * load doesn't crash.
 */

'use strict';

process.env.APP_BASE_URL = 'https://app.test';
process.env.ENVIRONMENT = 'dev';

const { test, expect, beforeEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { secretsStore } = require('./test-support');
const common = require('./common');

let fetchCalls;
let jobCalls;
// When set, the canvaFetch stub throws it once (then auto-clears) — used to
// drive withAuth's 401/rate-limited/canva-error mapping branches.
let fetchError;

const originalAuthorizeUser = common.authorizeUser;
const originalCanvaFetch = common.canvaFetch;
const originalStartAndPollJob = common.startAndPollJob;

common.authorizeUser = async () => 'access-tok';
common.canvaFetch = async (token, method, reqPath, opts) => {
  if (fetchError) {
    const err = fetchError;
    fetchError = null;
    throw err;
  }
  fetchCalls.push({ token, method, path: reqPath, opts: opts || {} });
  if (reqPath === '/v1/asset-uploads') {
    return { job: { id: 'up-1', status: 'success', asset: { id: 'asset-1' } } };
  }
  return { ok: true, path: reqPath };
};
common.startAndPollJob = async (token, startPath, pollPrefix, body) => {
  jobCalls.push({ token, startPath, pollPrefix, body });
  return { id: 'job-1', status: 'success', urls: ['https://export/file.pdf'] };
};

const { main } = require('./run');

common.authorizeUser = originalAuthorizeUser;
common.canvaFetch = originalCanvaFetch;
common.startAndPollJob = originalStartAndPollJob;

const EMAIL = 'teacher@psd401.net';

beforeEach(() => {
  fetchCalls = [];
  jobCalls = [];
  fetchError = null;
});

async function runCli(argv) {
  process.argv = ['node', 'run.js', ...argv];
  // Swallow stdout so the emitted JSON doesn't pollute the test log.
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await main();
  } finally {
    process.stdout.write = originalWrite;
  }
}

// Run the CLI expecting a structured exit: captures the emitted JSON and the
// exit code (process.exit is stubbed to throw a sentinel, like common.test.js).
async function runCliExpectExit(argv) {
  process.argv = ['node', 'run.js', ...argv];
  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  const originalExit = process.exit.bind(process);
  let exitCode;
  process.exit = (code) => { exitCode = code; throw new Error('__test_exit__'); };
  try {
    await expect(main()).rejects.toThrow('__test_exit__');
  } finally {
    process.stdout.write = originalWrite;
    process.exit = originalExit;
  }
  return { exitCode, emitted: JSON.parse(chunks.join('')) };
}

test('whoami → GET /v1/users/me, enriched with /v1/users/me/profile', async () => {
  await runCli(['--user', EMAIL, 'whoami']);
  expect(fetchCalls).toHaveLength(2);
  expect(fetchCalls[0].method).toBe('GET');
  expect(fetchCalls[0].path).toBe('/v1/users/me');
  expect(fetchCalls[1].path).toBe('/v1/users/me/profile');
});

test('withAuth maps a mid-call 401 to needs-auth (exit 10)', async () => {
  fetchError = Object.assign(new Error('Canva API 401'), { code: 'unauthorized', status: 401 });
  // emitNeedsAuthAndExit reads the internal API key from (mocked) Secrets
  // Manager and mints a consent link over real fetch — stub both.
  secretsStore['psd-agent/dev/internal-api-key'] = 'internal-api-key';
  const originalGlobalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/agent/consent-link')) {
      return new Response(
        JSON.stringify({ url: 'https://app.test/agent-connect-canva?token=abc' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };
  try {
    const { exitCode, emitted } = await runCliExpectExit(['--user', EMAIL, 'whoami']);
    expect(exitCode).toBe(10);
    expect(emitted.status).toBe('needs-auth');
    expect(emitted.kind).toBe('canva');
  } finally {
    globalThis.fetch = originalGlobalFetch;
  }
});

test('withAuth maps an exhausted rate limit to rate-limited (exit 14)', async () => {
  fetchError = Object.assign(new Error('Canva API 429 after retries'), { code: 'rate_limited', status: 429 });
  const { exitCode, emitted } = await runCliExpectExit(['--user', EMAIL, 'whoami']);
  expect(exitCode).toBe(14);
  expect(emitted.status).toBe('rate-limited');
  expect(emitted.tool).toBe('whoami');
});

test('withAuth maps any other Canva failure to canva-error (exit 12)', async () => {
  fetchError = Object.assign(new Error('Canva API error: HTTP 500'), { code: 'http_500', status: 500 });
  const { exitCode, emitted } = await runCliExpectExit(['--user', EMAIL, 'whoami']);
  expect(exitCode).toBe(12);
  expect(emitted.status).toBe('canva-error');
  expect(emitted.code).toBe('http_500');
  expect(emitted.http_status).toBe(500);
});

test('a value-flag passed without a value fails loudly instead of being ignored', async () => {
  const originalExit = process.exit.bind(process);
  const originalErrWrite = process.stderr.write.bind(process.stderr);
  let exitCode;
  const errChunks = [];
  process.exit = (code) => { exitCode = code; throw new Error('__test_exit__'); };
  process.stderr.write = (chunk) => { errChunks.push(chunk); return true; };
  process.argv = ['node', 'run.js', '--user', EMAIL, 'list-designs', '--query'];
  try {
    await expect(main()).rejects.toThrow('__test_exit__');
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalErrWrite;
  }
  expect(exitCode).toBe(1);
  expect(errChunks.join('')).toContain('--query requires a value');
  expect(fetchCalls).toHaveLength(0);
});

test('list-designs forwards query/ownership/sort-by as GET params', async () => {
  await runCli(['--user', EMAIL, 'list-designs', '--query', 'poster', '--ownership', 'owned', '--sort-by', 'modified_descending']);
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].method).toBe('GET');
  expect(fetchCalls[0].path).toBe('/v1/designs');
  expect(fetchCalls[0].opts.query).toEqual({
    query: 'poster',
    ownership: 'owned',
    sort_by: 'modified_descending',
  });
});

test('create-design with a preset builds design_type {type:preset,name}', async () => {
  await runCli(['--user', EMAIL, 'create-design', '--design-type', 'doc', '--title', 'My Doc']);
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].method).toBe('POST');
  expect(fetchCalls[0].path).toBe('/v1/designs');
  expect(fetchCalls[0].opts.body).toEqual({
    type: 'type_and_asset',
    title: 'My Doc',
    design_type: { type: 'preset', name: 'doc' },
  });
});

test('create-design with width/height builds a custom design_type', async () => {
  await runCli(['--user', EMAIL, 'create-design', '--width', '800', '--height', '600']);
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].opts.body).toEqual({
    type: 'type_and_asset',
    design_type: { type: 'custom', width: 800, height: 600 },
  });
});

test('create-design accepts --asset-id alone (no design_type)', async () => {
  await runCli(['--user', EMAIL, 'create-design', '--asset-id', 'Msd59349ff']);
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].opts.body).toEqual({
    type: 'type_and_asset',
    asset_id: 'Msd59349ff',
  });
});

test('export starts+polls the /v1/exports job with a format object', async () => {
  await runCli(['--user', EMAIL, 'export', '--design-id', 'DAF123', '--format', 'pdf']);
  expect(jobCalls).toHaveLength(1);
  expect(jobCalls[0].startPath).toBe('/v1/exports');
  expect(jobCalls[0].pollPrefix).toBe('/v1/exports');
  expect(jobCalls[0].body).toEqual({
    design_id: 'DAF123',
    format: { type: 'pdf' },
  });
});

test('export --pages parses a CSV page list into format.pages', async () => {
  await runCli(['--user', EMAIL, 'export', '--design-id', 'DAF123', '--format', 'png', '--pages', '1,3, 5']);
  expect(jobCalls[0].body).toEqual({
    design_id: 'DAF123',
    format: { type: 'png', pages: [1, 3, 5] },
  });
});

test('upload-asset reads the file and POSTs binary to /v1/asset-uploads with metadata header', async () => {
  // mkdtemp creates a unique, owner-only (0700) directory — avoids the
  // predictable-path-in-shared-tmp pattern CodeQL flags (js/insecure-temporary-file).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psd-canva-test-'));
  const tmp = path.join(tmpDir, 'asset.txt');
  fs.writeFileSync(tmp, 'hello-canva');
  try {
    await runCli(['--user', EMAIL, 'upload-asset', '--file', tmp, '--name', 'My Asset']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].method).toBe('POST');
  expect(fetchCalls[0].path).toBe('/v1/asset-uploads');
  expect(fetchCalls[0].opts.headers['Content-Type']).toBe('application/octet-stream');
  const meta = JSON.parse(fetchCalls[0].opts.headers['Asset-Upload-Metadata']);
  expect(Buffer.from(meta.name_base64, 'base64').toString('utf8')).toBe('My Asset');
  expect(Buffer.isBuffer(fetchCalls[0].opts.rawBody)).toBe(true);
});
