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

test('discovers the live roster through the generic broker route', async () => {
  let seen;
  gateway._internals.requestAgentBroker = async (...args) => {
    seen = args;
    return { tools: [{ name: 'get_example_schema', inputSchema: {} }] };
  };
  const tools = await gateway.listGatewayTools();
  assert.equal(tools[0].name, 'get_example_schema');
  assert.deepEqual(seen, [
    '/api/agent/workflow-gateway',
    { action: 'list-tools' },
    { timeoutMs: 155_000 },
  ]);
});

test('forwards any roster-selected tool and arguments', async () => {
  let seen;
  gateway._internals.requestAgentBroker = async (...args) => {
    seen = args;
    return { isError: false, data: { ok: true } };
  };
  const toolName = ['future', 'workflow', 'action'].join('_');
  const result = await gateway.callGatewayTool(toolName, { value: 'ready' });
  assert.deepEqual(result, { isError: false, data: { ok: true } });
  assert.deepEqual(seen, [
    '/api/agent/workflow-gateway',
    { toolName, arguments: { value: 'ready' } },
    { timeoutMs: 155_000 },
  ]);
});

test('maps configuration, tool, and transport failures to stable error classes', async () => {
  gateway._internals.requestAgentBroker = async () => {
    throw Object.assign(new Error('missing'), { status: 503 });
  };
  await assert.rejects(() => gateway.listGatewayTools(), gateway.GatewayConfigError);

  gateway._internals.requestAgentBroker = async () => {
    throw Object.assign(new Error('rejected'), {
      status: 400,
      responseBody: { error: 'Missing [caller-bound] marker' },
    });
  };
  await assert.rejects(
    () => gateway.callGatewayTool('submit_example', {}),
    (error) =>
      error instanceof gateway.GatewayToolError &&
      error.responseBody.error.includes('[caller-bound]')
  );

  gateway._internals.requestAgentBroker = async () => {
    throw new Error('offline');
  };
  await assert.rejects(
    () => gateway.listGatewayTools(),
    gateway.GatewayTransportError
  );
});

test('model-facing gateway contains no service secret, bearer, or direct gateway path', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'gateway.js'), 'utf8');
  assert.doesNotMatch(source, /SecretsManager|GetSecretValue|Authorization/);
  assert.doesNotMatch(source, /AGENT_GATEWAY_(?:TOKEN|SSE_URL|CONFIG_SECRET_ID)/);
  assert.doesNotMatch(source, /n8n|\/mcp\//);
});
