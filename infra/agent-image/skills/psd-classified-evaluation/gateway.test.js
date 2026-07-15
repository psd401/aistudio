'use strict';
// Tests for the MCP-over-SSE gateway client (#1230).
//
// Covers the pure SSE parsing helpers, endpoint resolution, tool-result
// unwrapping, config resolution (env + Secrets Manager fallback), and a full
// initialize + tools/call round-trip driven by a fake fetch that simulates the
// gateway's SSE stream (endpoint announcement + id-correlated message frames).
//
// Run: node --test   (from skills/psd-classified-evaluation/)

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  RATING_VALUES,
  resolveConfig,
  parseSseBuffer,
  resolveEndpointUrl,
  unwrapToolResult,
  GatewayClient,
  GatewayToolError,
  GatewayTransportError,
  _internals,
} = require('./gateway');

// --- pure helpers -----------------------------------------------------------

test('parseSseBuffer splits complete frames and keeps the trailing partial', () => {
  const input =
    'event: endpoint\ndata: /messages?sessionId=abc\n\n' +
    ': keepalive comment\n\n' +
    'event: message\ndata: {"id":1}\n\n' +
    'event: message\ndata: {"partial"'; // incomplete
  const { frames, rest } = parseSseBuffer(input);
  assert.deepStrictEqual(frames[0], { event: 'endpoint', data: '/messages?sessionId=abc' });
  // The comment-only frame yields event=message with empty data.
  assert.deepStrictEqual(frames[1], { event: 'message', data: '' });
  assert.deepStrictEqual(frames[2], { event: 'message', data: '{"id":1}' });
  assert.ok(rest.includes('{"partial"'), 'incomplete frame is retained as rest');
});

test('parseSseBuffer joins multi-line data and strips one leading space', () => {
  const { frames } = parseSseBuffer('event: message\ndata: line1\ndata: line2\n\n');
  assert.strictEqual(frames[0].data, 'line1\nline2');
});

test('parseSseBuffer normalizes CRLF', () => {
  const { frames } = parseSseBuffer('event: endpoint\r\ndata: /m\r\n\r\n');
  assert.deepStrictEqual(frames[0], { event: 'endpoint', data: '/m' });
});

test('resolveEndpointUrl resolves a relative path against the SSE origin', () => {
  assert.strictEqual(
    resolveEndpointUrl('https://gw.example/mcp/sse', '/mcp/messages?sessionId=x'),
    'https://gw.example/mcp/messages?sessionId=x'
  );
  assert.strictEqual(
    resolveEndpointUrl('https://gw.example/sse', 'https://gw.example/messages?sessionId=y'),
    'https://gw.example/messages?sessionId=y'
  );
});

test('unwrapToolResult parses the JSON text envelope + isError', () => {
  assert.deepStrictEqual(
    unwrapToolResult({ content: [{ type: 'text', text: '{"success":true,"envelopeId":"e1"}' }] }),
    { isError: false, data: { success: true, envelopeId: 'e1' } }
  );
  assert.deepStrictEqual(
    unwrapToolResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }),
    { isError: true, data: 'boom' }
  );
});

// --- config resolution ------------------------------------------------------

function clearGatewayEnv() {
  delete process.env.AGENT_GATEWAY_SSE_URL;
  delete process.env.AGENT_GATEWAY_TOKEN;
  delete process.env.AGENT_GATEWAY_TOKEN_SECRET_ID;
}

beforeEach(clearGatewayEnv);

test('resolveConfig throws when the SSE URL is unset', async () => {
  await assert.rejects(() => resolveConfig(), /AGENT_GATEWAY_SSE_URL is not set/);
});

test('resolveConfig throws when no token source is configured', async () => {
  process.env.AGENT_GATEWAY_SSE_URL = 'https://gw.example/sse';
  await assert.rejects(() => resolveConfig(), /No gateway bearer token configured/);
});

test('resolveConfig prefers the direct token env var', async () => {
  process.env.AGENT_GATEWAY_SSE_URL = 'https://gw.example/sse';
  process.env.AGENT_GATEWAY_TOKEN = 'direct-tok';
  assert.deepStrictEqual(await resolveConfig(), { url: 'https://gw.example/sse', token: 'direct-tok' });
});

test('resolveConfig falls back to Secrets Manager', async () => {
  process.env.AGENT_GATEWAY_SSE_URL = 'https://gw.example/sse';
  process.env.AGENT_GATEWAY_TOKEN_SECRET_ID = 'psd-agent/dev/agent-gateway-token';
  const orig = _internals.requireSecretsManager;
  _internals.requireSecretsManager = () => ({
    SecretsManagerClient: class { async send() { return { SecretString: '  secret-tok  ' }; } },
    GetSecretValueCommand: class { constructor(a) { this.a = a; } },
  });
  try {
    assert.deepStrictEqual(await resolveConfig(), { url: 'https://gw.example/sse', token: 'secret-tok' });
  } finally {
    _internals.requireSecretsManager = orig;
  }
});

// --- full SSE round-trip ----------------------------------------------------

// Build a fake fetch that simulates the gateway: the GET returns an SSE stream
// which first announces the endpoint, then for each POSTed request pushes an
// id-correlated response frame produced by `onRequest`.
function makeFakeGateway({ onRequest, getStatus = 200, postStatus = 202 }) {
  const enc = new TextEncoder();
  const queued = [];
  let resolveRead = null;
  function push(text) {
    const data = enc.encode(text);
    if (resolveRead) { const r = resolveRead; resolveRead = null; r({ value: data, done: false }); }
    else queued.push(data);
  }
  const reader = {
    read() {
      if (queued.length) return Promise.resolve({ value: queued.shift(), done: false });
      return new Promise((res) => { resolveRead = res; });
    },
  };
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (method === 'GET') {
      if (getStatus !== 200) return { ok: false, status: getStatus, text: async () => 'stream error' };
      queueMicrotask(() => push('event: endpoint\ndata: /messages?sessionId=sess-1\n\n'));
      return { ok: true, status: 200, body: { getReader: () => reader } };
    }
    const body = JSON.parse(opts.body);
    if (body.id != null) {
      const response = onRequest(body);
      if (response) queueMicrotask(() => push(`event: message\ndata: ${JSON.stringify(response)}\n\n`));
    }
    if (postStatus < 200 || postStatus >= 300) {
      return { ok: false, status: postStatus, text: async () => 'rejected' };
    }
    return { ok: true, status: postStatus, text: async () => '' };
  };
  return { fetchImpl };
}

function stdReply(body, extra) {
  return { jsonrpc: '2.0', id: body.id, ...extra };
}

test('completes initialize + tools/call round-trip and unwraps the payload', async () => {
  const { fetchImpl } = makeFakeGateway({
    onRequest: (body) => {
      if (body.method === 'initialize') return stdReply(body, { result: { protocolVersion: '2024-11-05' } });
      if (body.method === 'tools/call' && body.params.name === 'get_classified_evaluation_schema') {
        return stdReply(body, { result: { content: [{ type: 'text', text: JSON.stringify({ scale: RATING_VALUES }) }] } });
      }
      return stdReply(body, { error: { code: -32601, message: 'unknown tool' } });
    },
  });
  const client = new GatewayClient({ url: 'https://gw.example/sse', token: 'tok', fetchImpl });
  await client.connect();
  const initResult = await client.initialize();
  assert.strictEqual(initResult.protocolVersion, '2024-11-05');
  const { isError, data } = await client.callTool('get_classified_evaluation_schema', {});
  client.close();
  assert.strictEqual(isError, false);
  assert.deepStrictEqual(data.scale, RATING_VALUES);
});

test('a JSON-RPC error from the gateway surfaces as GatewayToolError', async () => {
  const { fetchImpl } = makeFakeGateway({
    onRequest: (body) =>
      body.method === 'initialize'
        ? stdReply(body, { result: {} })
        : stdReply(body, { error: { code: -32000, message: 'supervisor mismatch' } }),
  });
  const client = new GatewayClient({ url: 'https://gw.example/sse', token: 'tok', fetchImpl });
  await client.connect();
  await client.initialize();
  await assert.rejects(() => client.callTool('list_supervised_employees', { evaluator_email: 'x@psd401.net' }), (err) => {
    assert.ok(err instanceof GatewayToolError);
    assert.match(err.message, /supervisor mismatch/);
    return true;
  });
  client.close();
});

test('connect throws GatewayTransportError on a non-2xx SSE stream', async () => {
  const { fetchImpl } = makeFakeGateway({ onRequest: () => null, getStatus: 401 });
  const client = new GatewayClient({ url: 'https://gw.example/sse', token: 'bad', fetchImpl });
  await assert.rejects(() => client.connect(), (err) => {
    assert.ok(err instanceof GatewayTransportError);
    assert.match(err.message, /HTTP 401/);
    return true;
  });
  client.close();
});

test('a non-2xx POST is a transport error even though the stream is open', async () => {
  const { fetchImpl } = makeFakeGateway({
    onRequest: (body) => (body.method === 'initialize' ? stdReply(body, { result: {} }) : null),
    postStatus: 500,
  });
  const client = new GatewayClient({ url: 'https://gw.example/sse', token: 'tok', fetchImpl, requestTimeoutMs: 2000 });
  await client.connect();
  await assert.rejects(() => client.initialize(), (err) => {
    assert.ok(err instanceof GatewayTransportError);
    assert.match(err.message, /HTTP 500/);
    return true;
  });
  client.close();
});
