'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { afterEach, beforeEach, expect, mock, test } = require('bun:test');

const brokerMock = mock(async () => ({
  httpStatus: 200,
  keySource: 'shared',
  payload: { jsonrpc: '2.0', id: 'test', result: { ok: true } },
}));

const common = require('./common');

class ExitError extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

let stdout;
let stderr;
let originalExit;
let originalStdoutWrite;
let originalStderrWrite;

beforeEach(() => {
  brokerMock.mockReset();
  brokerMock.mockResolvedValue({
    httpStatus: 200,
    keySource: 'shared',
    payload: { jsonrpc: '2.0', id: 'test', result: { ok: true } },
  });
  common._internals.requestAgentBroker = brokerMock;
  stdout = [];
  stderr = [];
  originalExit = process.exit;
  originalStdoutWrite = process.stdout.write;
  originalStderrWrite = process.stderr.write;
  process.exit = (code) => {
    throw new ExitError(code);
  };
  process.stdout.write = (value) => {
    stdout.push(String(value));
    return true;
  };
  process.stderr.write = (value) => {
    stderr.push(String(value));
    return true;
  };
});

afterEach(() => {
  process.exit = originalExit;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

test('forwards only the MCP operation to the fixed owner-bound broker', async () => {
  const result = await common.callMcpRaw(
    'tools/call',
    { name: 'describe_capabilities', arguments: {} },
    'attacker-selected@psd401.net',
    1234
  );

  expect(result).toEqual({ result: { ok: true }, keySource: 'shared' });
  expect(brokerMock).toHaveBeenCalledWith(
    '/api/agent/aistudio',
    {
      method: 'tools/call',
      params: { name: 'describe_capabilities', arguments: {} },
    },
    { timeoutMs: 1234 }
  );
  const serializedCall = JSON.stringify(brokerMock.mock.calls[0]);
  expect(serializedCall).not.toContain('attacker-selected');
  expect(serializedCall).not.toContain('Authorization');
});

test('mints consent without forwarding a model-selected owner', async () => {
  brokerMock.mockResolvedValue({
    url: 'https://app.example/agent-connect-aistudio?token=signed',
  });

  await expect(
    common.mintConsentUrl('victim@psd401.net')
  ).resolves.toContain('/agent-connect-aistudio');
  expect(brokerMock).toHaveBeenCalledWith(
    '/api/agent/consent-link',
    { kind: 'aistudio' }
  );
  expect(JSON.stringify(brokerMock.mock.calls[0])).not.toContain('victim');
});

test('disconnects only through the owner-bound broker', async () => {
  brokerMock.mockResolvedValue({ disconnected: true });

  await expect(
    common.disconnectOAuth('victim@psd401.net')
  ).resolves.toEqual({ disconnected: true });
  expect(brokerMock).toHaveBeenCalledWith('/api/agent/aistudio', {
    operation: 'disconnect',
  });
  expect(JSON.stringify(brokerMock.mock.calls[0])).not.toContain('victim');
});

test('preserves the OAuth credential source returned by the broker', async () => {
  brokerMock.mockResolvedValue({
    httpStatus: 200,
    keySource: 'oauth',
    payload: { jsonrpc: '2.0', id: 'test', result: { ok: true } },
  });

  await expect(
    common.callMcpRaw('tools/list', {}, 'victim@psd401.net')
  ).resolves.toEqual({ result: { ok: true }, keySource: 'oauth' });
  expect(JSON.stringify(brokerMock.mock.calls[0])).not.toContain('victim');
});

test.each([
  [401, 11, 'unauthorized'],
  [429, 14, 'rate-limited'],
])('maps upstream HTTP %s to exit %s', async (httpStatus, exitCode, status) => {
  brokerMock.mockResolvedValue({
    httpStatus,
    keySource: 'personal',
    payload: { error: 'upstream' },
  });
  await expect(common.callMcpRaw('tools/list', {}, undefined)).rejects.toMatchObject({
    code: exitCode,
  });
  expect(stdout.join('')).toContain(status);
});

test('returns JSON-RPC errors without retrying or exposing a key', async () => {
  brokerMock.mockResolvedValue({
    httpStatus: 200,
    keySource: 'personal',
    payload: {
      jsonrpc: '2.0',
      id: 'test',
      error: { code: -32602, message: 'Insufficient scope' },
    },
  });
  await expect(common.callMcpRaw('tools/list', {}, undefined)).resolves.toEqual({
    jsonrpcError: { code: -32602, message: 'Insufficient scope' },
    httpStatus: 200,
    keySource: 'personal',
  });
  expect(brokerMock).toHaveBeenCalledTimes(1);
});

test('unwraps a brokered tool result', async () => {
  brokerMock.mockResolvedValue({
    httpStatus: 200,
    keySource: 'shared',
    payload: {
      jsonrpc: '2.0',
      id: 'test',
      result: {
        content: [{ type: 'text', text: '{"value":42}' }],
        isError: false,
      },
    },
  });
  await expect(common.callTool('list_assistants', {}, undefined)).resolves.toEqual({
    isError: false,
    payload: { value: 42 },
    keySource: 'shared',
  });
});

test('model-facing helper contains no provider-secret or bearer-token path', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'common.js'), 'utf8');
  expect(source).not.toContain('SecretsManager');
  expect(source).not.toContain('GetSecretValue');
  expect(source).not.toContain('Authorization');
  expect(source).not.toContain('AISTUDIO_MCP_API_KEY');
});
