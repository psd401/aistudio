'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { afterEach, beforeEach, expect, mock, test } = require('bun:test');

const brokerMock = mock(async () => ({
  httpStatus: 200,
  payload: { data: { id: 'content-1' } },
}));
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
  brokerMock.mockResolvedValue({
    httpStatus: 200,
    payload: { data: { id: 'content-1' } },
  });
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

test('forwards a bounded operation to the fixed owner-bound broker', async () => {
  await expect(
    common.restFetch('POST', '/content-1/versions', {
      query: { query: 'term', empty: '', absent: undefined },
      body: { title: 'Version' },
    })
  ).resolves.toEqual({
    approvalRequired: false,
    status: 200,
    payload: { id: 'content-1' },
  });
  expect(brokerMock).toHaveBeenCalledWith(
    '/api/agent/atrium',
    {
      method: 'POST',
      path: '/content-1/versions',
      query: { query: 'term' },
      body: { title: 'Version' },
    },
    { timeoutMs: 35_000 }
  );
});

test('treats HTTP 202 as a successful approval-required result', async () => {
  brokerMock.mockResolvedValue({
    httpStatus: 202,
    payload: { data: { status: 'approval_required' } },
  });
  await expect(
    common.restFetch('POST', '/content-1/publish', {
      body: { destination: 'intranet' },
    })
  ).resolves.toEqual({
    approvalRequired: true,
    status: 202,
    payload: { status: 'approval_required' },
  });
});

test.each([
  [401, 11, 'unauthorized'],
  [429, 14, 'rate-limited'],
])('maps brokered upstream HTTP %s to exit %s', async (httpStatus, code, status) => {
  brokerMock.mockResolvedValue({
    httpStatus,
    payload: { error: { code: 'upstream', message: 'rejected' } },
  });
  await expect(common.restFetch('GET', '')).rejects.toMatchObject({ code });
  expect(output.join('')).toContain(status);
});

test('fails closed on a non-JSON upstream error', async () => {
  brokerMock.mockResolvedValue({
    httpStatus: 502,
    payload: null,
    rawText: 'gateway unavailable',
  });
  await expect(common.restFetch('GET', '')).rejects.toMatchObject({ code: 12 });
  expect(output.join('')).toContain('gateway unavailable');
});

test('encodes artifact source for WAF-safe transit', () => {
  const value = '<script>✓</script>';
  const encoded = common.encodeContentBody(value);
  expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(value);
  expect(common.withEncodedBody({ body: value, title: 'x' })).toEqual({
    body: encoded,
    title: 'x',
    codeEncoding: 'base64',
  });
  expect(common.withEncodedBody({ title: 'x' })).toEqual({ title: 'x' });
});

test('parses lists and grant selectors without prototype-shaped accumulation', () => {
  expect(common.parseList('a, b,,c')).toEqual(['a', 'b', 'c']);
  expect(common.parseGrants('role:staff,group:team@psd401.net')).toEqual([
    { kind: 'role', value: 'staff' },
    { kind: 'group', value: 'team@psd401.net' },
  ]);
});

test('rejects malformed grant selectors', () => {
  expect(() => common.parseGrants('unknown:value')).toThrow(
    expect.objectContaining({ code: 1 })
  );
});

test('model-facing helper contains no provider credential path', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'common.js'), 'utf8');
  expect(source).not.toContain('SecretsManager');
  expect(source).not.toContain('GetSecretValue');
  expect(source).not.toContain('Authorization');
  expect(source).not.toContain('AISTUDIO_CONTENT_API_KEY');
});
