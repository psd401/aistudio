'use strict';
// Tests for how fsFetch reports a Freshservice 403.
//
// Freshservice authorizes per endpoint AND per workspace, so a 403 scopes one
// call and says nothing about the key. Reporting it as a bad key sent four
// users off to re-issue working credentials on 2026-08-17. normalizeFreshserviceResult
// is not exported, so exercise the branch through fsFetch — the surface all 13
// command scripts actually call, and the one a refactor would regress.
//
// requestAgentBroker is replaced on the ../../_shared/agent-broker module BEFORE
// api.js is required, so api.js captures the stub in its destructured
// `const { requestAgentBroker } = require(...)`. `node --test` runs each test
// file in its own process, so this cache surgery is isolated from siblings.
//
// Run: node --test   (from infra/agent-image/skills/psd-freshservice/)

const { test } = require('node:test');
const assert = require('node:assert');

const brokerPath = require.resolve('../../_shared/agent-broker');
require(brokerPath); // ensure the module is cached before we patch it

let brokerResult = null;
require.cache[brokerPath].exports.requestAgentBroker = async () => brokerResult;

const { fsFetch } = require('./api');

test('a 403 names the caller role, not the key, and stays off the generic path', async () => {
  brokerResult = {
    ok: false,
    status: 403,
    data: { code: 'access_denied', message: 'You are not authorized' },
  };
  const result = await fsFetch(null, '/tickets?workspace_id=8');

  assert.strictEqual(result.__ok, false);
  assert.strictEqual(result.status, 403);
  assert.strictEqual(result.code, 'freshservice_endpoint_forbidden');
  // The upstream body must survive so the agent can still report specifics.
  assert.match(result.error, /access_denied/);
  // The load-bearing part: the agent must not blame the stored credential.
  assert.match(result.error, /do not tell the user it is invalid/);
  assert.match(result.error, /re-issue/);
  assert.match(result.error, /freshservice_key_missing/);
});

test('other upstream failures keep the generic shape and no 403 code', async () => {
  for (const status of [400, 404, 500]) {
    brokerResult = { ok: false, status, data: { message: 'nope' } };
    const result = await fsFetch(null, '/tickets/1');

    assert.strictEqual(result.__ok, false, `status ${status}`);
    assert.strictEqual(result.status, status);
    assert.strictEqual(result.code, undefined, `status ${status} must not be tagged forbidden`);
    assert.ok(
      result.error.startsWith(`API error ${status}:`),
      `status ${status} error should open with its status: ${result.error}`,
    );
  }
});

test('a successful call is unaffected', async () => {
  brokerResult = { ok: true, status: 200, data: { tickets: [{ id: 7 }] } };
  const result = await fsFetch(null, '/tickets');

  assert.strictEqual(result.__ok, true);
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(result.data, { tickets: [{ id: 7 }] });
});
