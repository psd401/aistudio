'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { afterEach, beforeEach, expect, mock, test } = require('bun:test');

const brokerMock = mock(async () => ({ connected: true }));

const common = require('./common');

class ExitError extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

let output;
let originalExit;
let originalStdoutWrite;
let originalStderrWrite;

beforeEach(() => {
  brokerMock.mockReset();
  brokerMock.mockResolvedValue({ connected: true });
  common._internals.requestAgentBroker = brokerMock;
  output = [];
  originalExit = process.exit;
  originalStdoutWrite = process.stdout.write;
  originalStderrWrite = process.stderr.write;
  process.exit = (code) => {
    throw new ExitError(code);
  };
  process.stdout.write = (value) => {
    output.push(String(value));
    return true;
  };
  process.stderr.write = () => true;
});

afterEach(() => {
  process.exit = originalExit;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

test('authorization check passes no owner selector and returns only an opaque sentinel', async () => {
  await expect(
    common.authorizeUser('attacker-selected@psd401.net')
  ).resolves.toBe('owner-bound-canva-broker');
  expect(brokerMock).toHaveBeenCalledWith('/api/agent/canva', {
    operation: 'status',
  });
  expect(JSON.stringify(brokerMock.mock.calls[0])).not.toContain(
    'attacker-selected'
  );
});

test('missing authorization mints consent for the signed owner only', async () => {
  brokerMock
    .mockResolvedValueOnce({ connected: false })
    .mockResolvedValueOnce({
      url: 'https://app.example/agent-connect-canva?token=opaque',
    });
  await expect(
    common.authorizeUser('attacker-selected@psd401.net')
  ).rejects.toMatchObject({ code: 10 });
  expect(brokerMock).toHaveBeenNthCalledWith(
    2,
    '/api/agent/consent-link',
    { kind: 'canva' }
  );
  expect(output.join('')).toContain('needs-auth');
});

test('Canva requests contain no bearer or owner and encode binary uploads', async () => {
  brokerMock.mockResolvedValue({
    httpStatus: 200,
    payload: { job: { id: 'job-1', status: 'in_progress' } },
  });
  const result = await common.canvaFetch(
    'model-controlled-token',
    'POST',
    '/v1/asset-uploads',
    {
      rawBody: Buffer.from('asset'),
      headers: {
        'Content-Type': 'application/octet-stream',
        'Asset-Upload-Metadata': '{"name_base64":"YS5wbmc="}',
      },
    }
  );
  expect(result).toEqual({ job: { id: 'job-1', status: 'in_progress' } });
  expect(brokerMock).toHaveBeenCalledWith(
    '/api/agent/canva',
    {
      operation: 'request',
      method: 'POST',
      path: '/v1/asset-uploads',
      rawBodyBase64: Buffer.from('asset').toString('base64'),
      uploadMetadata: '{"name_base64":"YS5wbmc="}',
    },
    { timeoutMs: 35_000 }
  );
  const serialized = JSON.stringify(brokerMock.mock.calls[0]);
  expect(serialized).not.toContain('model-controlled-token');
  expect(serialized).not.toContain('Authorization');
});

test('retries a brokered 429 and then succeeds', async () => {
  brokerMock
    .mockResolvedValueOnce({
      httpStatus: 429,
      payload: null,
      retryAfter: '0',
    })
    .mockResolvedValueOnce({
      httpStatus: 200,
      payload: { items: [] },
    });
  await expect(
    common.canvaFetch('opaque', 'GET', '/v1/designs')
  ).resolves.toEqual({ items: [] });
  expect(brokerMock).toHaveBeenCalledTimes(2);
});

test('surfaces a brokered 401 as an authorization failure', async () => {
  brokerMock.mockResolvedValue({ httpStatus: 401, payload: null });
  await expect(
    common.canvaFetch('opaque', 'GET', '/v1/users/me')
  ).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
});

test('model-facing helper contains no OAuth or Secrets Manager credential path', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'common.js'), 'utf8');
  expect(source).not.toContain('SecretsManager');
  expect(source).not.toContain('GetSecretValue');
  expect(source).not.toContain('PutSecretValue');
  expect(source).not.toContain('Authorization');
  expect(source).not.toContain('refresh_token');
});
