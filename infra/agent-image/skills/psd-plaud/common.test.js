/**
 * Regression tests for common.js's MCP boundary (issue #1104 points 2 and 1b).
 *
 * 1. digestRecording must call get_transcript with `file_id`, not `id`.
 * 2. invokeTool must treat a JSON-RPC SUCCESS whose result carries
 *    `isError: true` (the MCP-spec shape for a tool-level failure) as a
 *    failure — emitting a structured mcp-error and exiting 12 — instead of
 *    returning `result` as if it were real tool content. Without this guard,
 *    digestRecording would pipe the error text into psd-summarize as if it
 *    were the transcript.
 *
 * The credential broker and Plaud MCP/OAuth HTTP calls are stubbed so these
 * tests exercise the real invokeTool/digestRecording logic end-to-end.
 */

'use strict';

const { test, expect, beforeEach, afterEach, mock } = require('bun:test');

const {
  credentialStore,
  brokerCalls,
  operationResults,
} = require('./mcp-test-support');

const common = require('./common');

let fetchCalls;
let originalFetch;

function jsonResponse(body, { headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  for (const key of Object.keys(credentialStore)) delete credentialStore[key];
  credentialStore.plaud = { refresh_token: 'stored-refresh', client_id: 'client-abc' };
  brokerCalls.length = 0;
  operationResults.length = 0;
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (url, init = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, init });
    if (u.includes('/token')) {
      return jsonResponse({ access_token: 'access-tok', refresh_token: 'refreshed-tok', expires_in: 3600 });
    }
    if (u.includes('mcp.plaud.ai/mcp')) {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 'sess-1' } });
      }
      if (body.method === 'notifications/initialized') {
        return jsonResponse({});
      }
      if (body.method === 'tools/call') {
        const result = operationResults.shift();
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result });
      }
    }
    throw new Error(`Unexpected fetch to ${u}`);
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function lastToolCallParams() {
  const call = brokerCalls.find(
    (item) =>
      item.route === '/api/agent/credentials' &&
      item.body.method === 'tools/call',
  );
  return call && {
    name: call.body.toolName,
    arguments: call.body.toolArgs,
  };
}

test('digestRecording calls get_transcript with file_id (not id)', async () => {
  operationResults.push({ content: [{ type: 'text', text: 'raw transcript text' }] });
  const cp = require('node:child_process');
  const originalSpawnSync = cp.spawnSync;
  cp.spawnSync = mock(() => ({
    status: 0,
    stdout: `${JSON.stringify({ status: 'ok', summary: 'summarized safely' })}\n`,
    stderr: '',
  }));
  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    await common.digestRecording('rec-555', {});
  } finally {
    process.stdout.write = originalWrite;
    cp.spawnSync = originalSpawnSync;
  }
  const params = lastToolCallParams();
  expect(params.name).toBe('get_transcript');
  expect(params.arguments).toEqual({ file_id: 'rec-555' });
  expect(chunks.join('')).toContain('summarized safely');
});

test('invokeTool treats an isError:true tool result as a failure (exit 12, mcp-error)', async () => {
  operationResults.push({
    content: [{ type: 'text', text: 'Upstream Plaud error: transcript not ready' }],
    isError: true,
  });
  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  const originalExit = process.exit.bind(process);
  let exitCode;
  process.exit = (code) => { exitCode = code; throw new Error('__test_exit__'); };
  try {
    await expect(common.callTool('get_transcript', { file_id: 'rec-1' })).rejects.toThrow('__test_exit__');
  } finally {
    process.stdout.write = originalWrite;
    process.exit = originalExit;
  }
  expect(exitCode).toBe(12);
  const emitted = JSON.parse(chunks.join(''));
  expect(emitted.status).toBe('mcp-error');
  expect(emitted.tool).toBe('get_transcript');
});

test('digestRecording does not pipe an isError tool result into psd-summarize', async () => {
  operationResults.push({
    content: [{ type: 'text', text: 'Upstream Plaud error: transcript not ready' }],
    isError: true,
  });
  const cp = require('node:child_process');
  const originalSpawnSync = cp.spawnSync;
  let spawnCalled = false;
  cp.spawnSync = mock(() => { spawnCalled = true; return { status: 0, stdout: '{}', stderr: '' }; });
  const originalExit = process.exit.bind(process);
  let exitCode;
  process.exit = (code) => { exitCode = code; throw new Error('__test_exit__'); };
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await expect(common.digestRecording('rec-2', {})).rejects.toThrow('__test_exit__');
  } finally {
    process.exit = originalExit;
    process.stdout.write = originalWrite;
    cp.spawnSync = originalSpawnSync;
  }
  expect(exitCode).toBe(12);
  expect(spawnCalled).toBe(false);
});

test('all Plaud credential operations are owner-bound broker calls', async () => {
  operationResults.push({ content: [] });
  await common.callTool('get_current_user', {});
  expect(brokerCalls[0]).toEqual({
    operation: 'request',
    route: '/api/agent/credentials',
    body: {
      operation: 'plaud-mcp',
      method: 'tools/call',
      toolName: 'get_current_user',
      toolArgs: {},
    },
  });
  expect(brokerCalls.some((call) => 'ownerEmail' in call)).toBe(false);
});
