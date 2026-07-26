'use strict';

const { test, expect, beforeAll, afterAll, mock } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const contextPath = path.join(os.tmpdir(), `agent-broker-context-${process.pid}`);
const contextToken = `v1.${'C'.repeat(40)}.${'D'.repeat(43)}`;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  fs.writeFileSync(contextPath, contextToken, { mode: 0o600 });
  process.env.PSD_INVOCATION_CONTEXT_FILE = contextPath;
  process.env.APP_BASE_URL = 'https://studio.example.test/untrusted/path';
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  fs.unlinkSync(contextPath);
  delete process.env.PSD_INVOCATION_CONTEXT_FILE;
  delete process.env.APP_BASE_URL;
});

test('uses a fixed allowlisted route with the signed context and no shared bearer', async () => {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ url: 'https://studio.example.test/connect' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  const { requestAgentBroker } = require('./agent-broker');
  await requestAgentBroker('/api/agent/consent-link', { kind: 'plaud' });
  const [url, init] = globalThis.fetch.mock.calls[0];
  expect(String(url)).toBe(
    'https://studio.example.test/api/agent/consent-link',
  );
  expect(init.headers['X-Agent-Invocation-Context']).toBe(contextToken);
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
