/**
 * Unit tests for psd-canva common.js — the auth + REST boundary.
 *
 * Covers:
 *   1. refreshCanvaAccessToken uses HTTP Basic auth (confidential client) with
 *      the refresh_token grant and returns the rotated refresh token.
 *   2. authorizeUser emits needs-auth (exit 10) when the user has no stored
 *      token yet, minting a consent link.
 *   3. authorizeUser writes the ROTATED refresh token back to Secrets Manager
 *      before returning (Canva single-use grant — the critical invariant).
 *   4. canvaFetch retries a 429 and then succeeds.
 *   5. canvaFetch surfaces a 401 as a typed 'unauthorized' error.
 *
 * Secrets Manager is stubbed via test-support; fetch is stubbed per-test.
 */

'use strict';

// common.js reads these at module-load time — set them BEFORE requiring it.
process.env.APP_BASE_URL = 'https://app.test';
process.env.ENVIRONMENT = 'dev';

const { test, expect, beforeEach, afterEach, mock } = require('bun:test');

const { secretsStore } = require('./test-support');
const common = require('./common');

const EMAIL = 'teacher@psd401.net';
const CANVA_TOKEN_SECRET_ID = `psd-agent-creds/dev/user/${EMAIL}/canva`;
const CANVA_OAUTH_SECRET_ID = 'psd-agent/dev/canva-oauth-client';
const INTERNAL_API_KEY_SECRET_ID = 'psd-agent/dev/internal-api-key';

let originalFetch;

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  for (const key of Object.keys(secretsStore)) delete secretsStore[key];
  secretsStore[CANVA_OAUTH_SECRET_ID] = { client_id: 'cid-123', client_secret: 'csecret-xyz' };
  secretsStore[INTERNAL_API_KEY_SECRET_ID] = 'internal-api-key';
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('refreshCanvaAccessToken uses Basic auth + refresh_token grant and returns the rotated token', async () => {
  let seen;
  globalThis.fetch = mock(async (url, init) => {
    seen = { url: String(url), init };
    return jsonResponse({ access_token: 'access-tok', refresh_token: 'rotated-rt', expires_in: 14400 });
  });

  const auth = await common.refreshCanvaAccessToken('stored-rt', 'cid-123', 'csecret-xyz');

  expect(seen.url).toContain('/rest/v1/oauth/token');
  expect(seen.init.method).toBe('POST');
  expect(seen.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  expect(seen.init.headers.Authorization).toBe(
    'Basic ' + Buffer.from('cid-123:csecret-xyz').toString('base64')
  );
  const body = new URLSearchParams(seen.init.body);
  expect(body.get('grant_type')).toBe('refresh_token');
  expect(body.get('refresh_token')).toBe('stored-rt');
  expect(auth.access_token).toBe('access-tok');
  expect(auth.refresh_token).toBe('rotated-rt');
});

test('authorizeUser emits needs-auth (exit 10) when the user has no stored token', async () => {
  // No canva token slot for this user → getUserCanvaRecord returns null.
  globalThis.fetch = mock(async (url) => {
    if (String(url).includes('/api/agent/consent-link')) {
      return jsonResponse({ url: 'https://app.test/agent-connect-canva?token=abc' });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  const originalExit = process.exit.bind(process);
  let exitCode;
  process.exit = (code) => { exitCode = code; throw new Error('__test_exit__'); };
  try {
    await expect(common.authorizeUser(EMAIL)).rejects.toThrow('__test_exit__');
  } finally {
    process.stdout.write = originalWrite;
    process.exit = originalExit;
  }
  expect(exitCode).toBe(10);
  const emitted = JSON.parse(chunks.join(''));
  expect(emitted.status).toBe('needs-auth');
  expect(emitted.kind).toBe('canva');
  expect(emitted.consent_chat_hyperlink).toContain('Connect your Canva account');
});

test('authorizeUser writes the rotated refresh token back to Secrets Manager', async () => {
  secretsStore[CANVA_TOKEN_SECRET_ID] = { refresh_token: 'stored-rt', obtained_at: '2026-01-01T00:00:00Z' };
  globalThis.fetch = mock(async (url) => {
    if (String(url).includes('/rest/v1/oauth/token')) {
      return jsonResponse({ access_token: 'access-tok', refresh_token: 'rotated-rt', expires_in: 14400 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const accessToken = await common.authorizeUser(EMAIL);
  expect(accessToken).toBe('access-tok');
  // The stored refresh token must have been replaced with the rotated one.
  expect(secretsStore[CANVA_TOKEN_SECRET_ID].refresh_token).toBe('rotated-rt');
});

test('canvaFetch retries a 429 then succeeds', async () => {
  let calls = 0;
  globalThis.fetch = mock(async () => {
    calls += 1;
    if (calls === 1) return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
    return jsonResponse({ items: [], continuation: null });
  });
  const result = await common.canvaFetch('access-tok', 'GET', '/v1/designs', { query: { query: 'x' } });
  expect(calls).toBe(2);
  expect(result).toEqual({ items: [], continuation: null });
});

test('canvaFetch surfaces a 401 as a typed unauthorized error', async () => {
  globalThis.fetch = mock(async () => new Response('', { status: 401 }));
  let caught;
  try {
    await common.canvaFetch('access-tok', 'GET', '/v1/users/me/profile');
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(caught.code).toBe('unauthorized');
  expect(caught.status).toBe(401);
});
