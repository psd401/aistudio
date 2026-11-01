/**
 * psd-prr CLI: argument handling, broker request shape, and the needs-auth
 * path that sends the user a one-time credential-entry link for `prr_pat`.
 *
 * The broker is injected, so nothing here touches the network. The broker's
 * own PRR behavior (Streamable HTTP, token header, 401 mapping) is pinned in
 * tests/unit/lib/agent-credentials/prr-broker.test.ts.
 */

'use strict';

const { test, expect, beforeEach } = require('bun:test');

const { runPrr, EXIT } = require('./run');

const ENTRY_URL = 'https://ai.psd401.net/agent-connect-credential?token=t1';

let calls;
let credentialsResponse;
let consentResponse;

function broker() {
  return async (route, body) => {
    calls.push({ route, body });
    if (route === '/api/agent/credentials') {
      if (credentialsResponse instanceof Error) throw credentialsResponse;
      return credentialsResponse;
    }
    if (route === '/api/agent/consent-link') {
      if (consentResponse instanceof Error) throw consentResponse;
      return consentResponse;
    }
    throw new Error(`unexpected route ${route}`);
  };
}

async function run(argv) {
  const out = [];
  const err = [];
  const code = await runPrr(argv, {
    requestAgentBroker: broker(),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  const stdout = out.join('');
  let json = null;
  try { json = JSON.parse(stdout); } catch { /* not JSON */ }
  return { code, stdout, stderr: err.join(''), json };
}

beforeEach(() => {
  calls = [];
  credentialsResponse = {
    status: 'ok',
    result: { content: [{ type: 'text', text: '{"total":4,"scan_complete":true}' }] },
  };
  consentResponse = { url: ENTRY_URL };
});

test('tools lists the live PRR tools through the broker', async () => {
  credentialsResponse = { status: 'ok', result: { tools: [{ name: 'psd_prr_requests_list' }] } };
  const { code, json } = await run(['tools']);
  expect(code).toBe(EXIT.ok);
  expect(json).toEqual({ tools: [{ name: 'psd_prr_requests_list' }] });
  expect(calls).toEqual([
    {
      route: '/api/agent/credentials',
      body: { operation: 'prr-mcp', method: 'tools/list', toolArgs: {} },
    },
  ]);
});

test('call forwards the tool name and JSON arguments', async () => {
  const { code, json } = await run([
    'call', 'psd_prr_overdue_requests_list', '--args', '{"limit":25}',
  ]);
  expect(code).toBe(EXIT.ok);
  expect(json).toEqual(credentialsResponse.result);
  expect(calls[0]).toEqual({
    route: '/api/agent/credentials',
    body: {
      operation: 'prr-mcp',
      method: 'tools/call',
      toolName: 'psd_prr_overdue_requests_list',
      toolArgs: { limit: 25 },
    },
  });
});

test('call with no --args sends an empty argument object', async () => {
  await run(['call', 'psd_prr_capabilities_list']);
  expect(calls[0].body.toolArgs).toEqual({});
});

test.each([
  ['a missing tool name', ['call']],
  ['a non-PRR tool name', ['call', 'list_files']],
  ['non-JSON --args', ['call', 'psd_prr_requests_list', '--args', 'limit=5']],
  ['a JSON array for --args', ['call', 'psd_prr_requests_list', '--args', '[1]']],
  ['an unknown subcommand', ['delete']],
  ['an identity selector', ['tools', '--user', 'someone@psd401.net']],
])('rejects %s without calling the broker', async (_label, argv) => {
  const { code } = await run(argv);
  expect(code).toBe(EXIT.usage);
  expect(calls).toHaveLength(0);
});

test.each([
  ['missing', 'prr_token_missing'],
  ['rejected (expired or revoked)', 'prr_token_rejected'],
])('a %s token returns a credential-entry link for prr_pat', async (_label, codeName) => {
  credentialsResponse = { status: 'needs-auth', reason: 'x', code: codeName };
  const { code, json } = await run(['call', 'psd_prr_requests_list']);

  expect(code).toBe(EXIT.needsAuth);
  expect(calls[1]).toEqual({
    route: '/api/agent/consent-link',
    body: { kind: 'credential_entry', name: 'prr_pat' },
  });
  expect(json).toMatchObject({
    status: 'needs-auth',
    code: codeName,
    credentialName: 'prr_pat',
    url: ENTRY_URL,
    tokenPage: 'https://prr.psd401.net/agent-access',
    expiresInMinutes: 15,
  });
  const text = JSON.stringify(json);
  expect(text).toContain('https://prr.psd401.net/agent-access');
  expect(text).toMatch(/do not ask .*paste/i);
});

test('needs-auth still exits 10 with guidance when the link cannot be minted', async () => {
  credentialsResponse = { status: 'needs-auth', reason: 'x', code: 'prr_token_rejected' };
  consentResponse = new Error('rate limited');
  const { code, json } = await run(['tools']);
  expect(code).toBe(EXIT.needsAuth);
  expect(json).toMatchObject({ status: 'needs-auth', code: 'prr_token_rejected', url: null });
  expect(JSON.stringify(json)).toContain('https://prr.psd401.net/agent-access');
});

test('a tool-level error (isError) is reported, not passed off as data', async () => {
  credentialsResponse = {
    status: 'ok',
    result: { isError: true, content: [{ type: 'text', text: 'request PRR-1 not found' }] },
  };
  const { code, json } = await run(['call', 'psd_prr_request_get', '--args', '{"id":"PRR-1"}']);
  expect(code).toBe(EXIT.upstream);
  expect(json).toEqual({
    status: 'mcp-error',
    tool: 'psd_prr_request_get',
    tool_error: 'request PRR-1 not found',
  });
});

test('a JSON-RPC error is reported as mcp-error', async () => {
  credentialsResponse = {
    status: 'ok',
    result: { jsonrpc: '2.0', id: '1', error: { code: -32602, message: 'bad params' } },
  };
  const { code, json } = await run(['call', 'psd_prr_requests_list']);
  expect(code).toBe(EXIT.upstream);
  expect(json).toMatchObject({ status: 'mcp-error', jsonrpc_error: { message: 'bad params' } });
});

test('forbidden and rate-limited map to their own exit codes', async () => {
  credentialsResponse = { status: 'forbidden', detail: 'role cannot read audit log' };
  let result = await run(['call', 'psd_prr_audit_log_search']);
  expect(result.code).toBe(EXIT.forbidden);
  expect(result.json).toMatchObject({ status: 'forbidden', detail: 'role cannot read audit log' });

  credentialsResponse = { status: 'rate-limited' };
  result = await run(['call', 'psd_prr_audit_log_search']);
  expect(result.code).toBe(EXIT.rateLimited);
});

test('a broker transport failure is an upstream error', async () => {
  credentialsResponse = new Error('Agent broker returned HTTP 502');
  const { code, stderr } = await run(['tools']);
  expect(code).toBe(EXIT.upstream);
  expect(stderr).toContain('HTTP 502');
});
