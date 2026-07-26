'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const gateway = require('./gateway');

const originalBroker = gateway._internals.requestAgentBroker;
afterEach(() => {
  gateway._internals.requestAgentBroker = originalBroker;
});

test('forwards only a named tool and arguments to the owner-bound broker', async () => {
  let seen;
  gateway._internals.requestAgentBroker = async (...args) => {
    seen = args;
    return { isError: false, data: { ok: true } };
  };
  const result = await gateway.callGatewayTool(
    'list_supervised_employees',
    { evaluator_email: 'attacker-selected@psd401.net' }
  );
  assert.deepEqual(result, { isError: false, data: { ok: true } });
  assert.deepEqual(seen, [
    '/api/agent/classified-evaluation',
    {
      toolName: 'list_supervised_employees',
      arguments: { evaluator_email: 'attacker-selected@psd401.net' },
    },
    { timeoutMs: 155_000 },
  ]);
});

test('maps configuration, tool, and transport failures to stable error classes', async () => {
  gateway._internals.requestAgentBroker = async () => {
    throw Object.assign(new Error('missing'), { status: 503 });
  };
  await assert.rejects(
    () => gateway.callGatewayTool('get_classified_evaluation_schema', {}),
    gateway.GatewayConfigError
  );

  gateway._internals.requestAgentBroker = async () => {
    throw Object.assign(new Error('rejected'), {
      status: 422,
      responseBody: { detail: { code: -1 } },
    });
  };
  await assert.rejects(
    () => gateway.callGatewayTool('submit_classified_evaluation', {}),
    (error) =>
      error instanceof gateway.GatewayToolError &&
      error.rpcError.code === -1
  );

  gateway._internals.requestAgentBroker = async () => {
    throw new Error('offline');
  };
  await assert.rejects(
    () => gateway.callGatewayTool('get_classified_evaluation_schema', {}),
    gateway.GatewayTransportError
  );
});

test('model-facing gateway contains no service secret, bearer, or direct network path', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'gateway.js'), 'utf8');
  assert.doesNotMatch(source, /SecretsManager|GetSecretValue|Authorization|fetch\(/);
  assert.doesNotMatch(source, /AGENT_GATEWAY_(?:TOKEN|SSE_URL|CONFIG_SECRET_ID)/);
});
