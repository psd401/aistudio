'use strict';

const { test, expect, beforeAll, afterAll, mock } = require('bun:test');
const originalFetch = globalThis.fetch;

beforeAll(() => {
  process.env.APP_BASE_URL = 'https://studio.example.test/untrusted/path';
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  delete process.env.APP_BASE_URL;
});

test('uses the fixed local relay without exposing signing authority', async () => {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ url: 'https://studio.example.test/connect' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  const { requestAgentBroker } = require('./agent-broker');
  await requestAgentBroker('/api/agent/consent-link', { kind: 'plaud' });
  const [url, init] = globalThis.fetch.mock.calls[0];
  expect(String(url)).toBe(
    'http://127.0.0.1:18791/agent-broker/api/agent/consent-link',
  );
  expect(init.headers['X-Agent-Invocation-Context']).toBeUndefined();
  expect(init.headers['X-Agent-Request-Proof-Signature']).toBeUndefined();
  expect(init.headers.Authorization).toBeUndefined();
  expect(init.redirect).toBe('error');
});

test('rejects non-allowlisted paths before network access', async () => {
  globalThis.fetch = mock(async () => new Response('{}'));
  const { requestAgentBroker } = require('./agent-broker');
  await expect(
    requestAgentBroker('https://attacker.test/', {}),
  ).rejects.toThrow('Unsupported agent broker route');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('rejects the retired raw Workspace-token endpoint before network access', async () => {
  globalThis.fetch = mock(async () => new Response('{}'));
  const { requestAgentBroker } = require('./agent-broker');
  await expect(
    requestAgentBroker('/api/agent/workspace-token', {}),
  ).rejects.toThrow('Unsupported agent broker route');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
