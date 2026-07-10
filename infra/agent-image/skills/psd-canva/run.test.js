/**
 * Regression tests for run.js's CLI subcommand → Canva REST wiring.
 *
 * Confirms each subcommand hits the correct method + path + body:
 *   whoami        → GET  /v1/users/me/profile
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

require('./test-support');
const common = require('./common');

let fetchCalls;
let jobCalls;

const originalAuthorizeUser = common.authorizeUser;
const originalCanvaFetch = common.canvaFetch;
const originalStartAndPollJob = common.startAndPollJob;

common.authorizeUser = async () => 'access-tok';
common.canvaFetch = async (token, method, reqPath, opts) => {
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

test('whoami → GET /v1/users/me/profile', async () => {
  await runCli(['--user', EMAIL, 'whoami']);
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].method).toBe('GET');
  expect(fetchCalls[0].path).toBe('/v1/users/me/profile');
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
    title: 'My Doc',
    design_type: { type: 'preset', name: 'doc' },
  });
});

test('create-design with width/height builds a custom design_type', async () => {
  await runCli(['--user', EMAIL, 'create-design', '--width', '800', '--height', '600']);
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].opts.body).toEqual({
    design_type: { type: 'custom', width: 800, height: 600 },
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

test('export --pages parses a CSV page list', async () => {
  await runCli(['--user', EMAIL, 'export', '--design-id', 'DAF123', '--format', 'png', '--pages', '1,3, 5']);
  expect(jobCalls[0].body).toEqual({
    design_id: 'DAF123',
    format: { type: 'png' },
    pages: [1, 3, 5],
  });
});

test('upload-asset reads the file and POSTs binary to /v1/asset-uploads with metadata header', async () => {
  const tmp = path.join(os.tmpdir(), `psd-canva-test-${Date.now()}.txt`);
  fs.writeFileSync(tmp, 'hello-canva');
  try {
    await runCli(['--user', EMAIL, 'upload-asset', '--file', tmp, '--name', 'My Asset']);
  } finally {
    fs.unlinkSync(tmp);
  }
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].method).toBe('POST');
  expect(fetchCalls[0].path).toBe('/v1/asset-uploads');
  expect(fetchCalls[0].opts.headers['Content-Type']).toBe('application/octet-stream');
  const meta = JSON.parse(fetchCalls[0].opts.headers['Asset-Upload-Metadata']);
  expect(Buffer.from(meta.name_base64, 'base64').toString('utf8')).toBe('My Asset');
  expect(Buffer.isBuffer(fetchCalls[0].opts.rawBody)).toBe(true);
});
