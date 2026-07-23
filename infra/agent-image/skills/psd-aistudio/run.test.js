/**
 * Regression tests for run.js's CLI subcommand → MCP tools/call wiring (#1223).
 *
 * Confirms each subcommand maps to the right MCP tool + arguments, threads the
 * optional --user through to key resolution, and handles the documented outcomes:
 *   - execute-assistant on a draft/missing id → { status: 'not_executable' }, exit 0
 *   - insufficient-scope JSON-RPC error → surfaced verbatim + a store/re-mint hint
 *   - capabilities / list stay on the back-compat callMcp path (unchanged)
 *
 * common.js's callTool/callMcp/emit are overridden on the shared module.exports
 * object BEFORE run.js is required, so run.js's top-level destructure captures the
 * stubs instead of hitting the network / Secrets Manager. process.exit is stubbed
 * to throw so `fail()` (missing-flag validation) and the exit-12 paths are
 * observable.
 */

'use strict';

// Keep the same env as common.test.js (bun loads both into one process; common.js
// fixes its consts at first require). run.js stubs callTool/callMcp, so the actual
// credential values are irrelevant here — only cross-file consistency matters.
process.env.AISTUDIO_MCP_URL = 'https://app.test/api/mcp';
process.env.AISTUDIO_MCP_API_KEY = '';
process.env.AISTUDIO_MCP_API_KEY_SECRET_ID = 'psd-agent/dev/aistudio-mcp-api-key';

const { test, expect, beforeEach, afterEach } = require('bun:test');

const common = require('./common');

let toolCalls;
let mcpCalls;
let emitted;
let toolResponder;

const originalCallTool = common.callTool;
const originalCallMcp = common.callMcp;
const originalEmit = common.emit;

common.callTool = async (toolName, toolArgs, callerEmail) => {
  toolCalls.push({ toolName, toolArgs: toolArgs || {}, callerEmail });
  return toolResponder();
};
common.callMcp = async (method, params, callerEmail) => {
  mcpCalls.push({ method, params: params || {}, callerEmail });
  return null;
};
common.emit = (obj) => {
  emitted.push(obj);
};

const { main } = require('./run');

common.callTool = originalCallTool;
common.callMcp = originalCallMcp;
common.emit = originalEmit;

class ExitError extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

let originalExit;
let originalArgv;
let originalStdoutWrite;
let originalStderrWrite;

function okResponder() {
  return { isError: false, payload: { ok: true }, keySource: 'personal' };
}

beforeEach(() => {
  toolCalls = [];
  mcpCalls = [];
  emitted = [];
  toolResponder = okResponder;
  originalExit = process.exit;
  originalArgv = process.argv;
  originalStdoutWrite = process.stdout.write;
  originalStderrWrite = process.stderr.write;
  process.exit = (code) => {
    throw new ExitError(code);
  };
  process.stdout.write = () => true;
  process.stderr.write = () => true;
});

afterEach(() => {
  process.exit = originalExit;
  process.argv = originalArgv;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

/** Run main() with the given argv (after `node run.js`). */
async function run(...argv) {
  process.argv = ['node', 'run.js', ...argv];
  await main();
}

// ── discovery (back-compat callMcp path) ───────────────────────────────────────

test('capabilities calls describe_capabilities via callMcp, threading --user', async () => {
  await run('capabilities', '--section', 'actions', '--surface', 'mcp', '--user', 'a@b.co');
  expect(toolCalls).toHaveLength(0);
  expect(mcpCalls).toHaveLength(1);
  expect(mcpCalls[0].method).toBe('tools/call');
  expect(mcpCalls[0].params).toEqual({
    name: 'describe_capabilities',
    arguments: { section: 'actions', surface: 'mcp' },
  });
  expect(mcpCalls[0].callerEmail).toBe('a@b.co');
});

test('capabilities without --user passes callerEmail undefined (unchanged behavior)', async () => {
  await run('capabilities');
  expect(mcpCalls[0].callerEmail).toBeUndefined();
});

test('list calls tools/list via callMcp', async () => {
  await run('list', '--user', 'a@b.co');
  expect(mcpCalls[0].method).toBe('tools/list');
  expect(mcpCalls[0].params).toEqual({});
  expect(mcpCalls[0].callerEmail).toBe('a@b.co');
});

test('capabilities rejects an invalid --section (exit 1)', async () => {
  let code;
  try {
    await run('capabilities', '--section', 'bogus');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

// ── list-assistants ────────────────────────────────────────────────────────────

test('list-assistants maps flags to the tool arguments and coerces --limit to a number', async () => {
  toolResponder = () => ({ isError: false, payload: { assistants: [] }, keySource: 'personal' });
  await run('list-assistants', '--user', 'a@b.co', '--search', 'math', '--status', 'approved', '--limit', '5');

  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0].toolName).toBe('list_assistants');
  expect(toolCalls[0].toolArgs).toEqual({ search: 'math', status: 'approved', limit: 5 });
  expect(toolCalls[0].callerEmail).toBe('a@b.co');
  expect(emitted[0]).toEqual({ assistants: [] });
});

test('list-assistants rejects a non-integer --limit (exit 1)', async () => {
  let code;
  try {
    await run('list-assistants', '--limit', 'lots');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

// ── execute-assistant ──────────────────────────────────────────────────────────

test('execute-assistant sends assistantId (number) + parsed inputs', async () => {
  toolResponder = () => ({
    isError: false,
    payload: { executionId: 'e1', text: 'done', usage: null },
    keySource: 'personal',
  });
  await run('execute-assistant', '--user', 'a@b.co', '--id', '12', '--inputs', '{"topic":"volcanoes"}');

  expect(toolCalls[0].toolName).toBe('execute_assistant');
  expect(toolCalls[0].toolArgs).toEqual({ assistantId: 12, inputs: { topic: 'volcanoes' } });
  expect(emitted[0].executionId).toBe('e1');
});

test('execute-assistant defaults inputs to {} when --inputs is omitted', async () => {
  await run('execute-assistant', '--id', '3');
  expect(toolCalls[0].toolArgs).toEqual({ assistantId: 3, inputs: {} });
});

test('execute-assistant requires --id (exit 1)', async () => {
  let code;
  try {
    await run('execute-assistant', '--inputs', '{}');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('execute-assistant rejects invalid --inputs JSON (exit 1)', async () => {
  let code;
  try {
    await run('execute-assistant', '--id', '3', '--inputs', 'not json');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('execute-assistant rejects a non-object --inputs (exit 1)', async () => {
  let code;
  try {
    await run('execute-assistant', '--id', '3', '--inputs', '[1,2]');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('execute-assistant on a DRAFT/missing id → not_executable, exit 0 (not 12)', async () => {
  toolResponder = () => ({
    isError: true,
    payload: 'Assistant execution failed: Record not found in assistant_architects with id: 99',
    keySource: 'personal',
  });

  // Must NOT throw (exit 0); emits a structured not_executable result.
  await run('execute-assistant', '--id', '99');

  expect(emitted).toHaveLength(1);
  expect(emitted[0].status).toBe('not_executable');
  expect(emitted[0].assistantId).toBe(99);
  expect(emitted[0].message).toMatch(/approved/i);
});

test('execute-assistant on a genuine tool error → tool-error, exit 12', async () => {
  toolResponder = () => ({
    isError: true,
    payload: 'Assistant execution failed: upstream model timeout',
    keySource: 'personal',
  });

  let code;
  try {
    await run('execute-assistant', '--id', '12');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(12);
  expect(emitted[0].status).toBe('tool-error');
});

// ── insufficient-scope hint (never retried / key-swapped) ──────────────────────

test('insufficient scope on the SHARED key → verbatim error + "store your own key" hint, exit 12', async () => {
  toolResponder = () => ({
    jsonrpcError: { code: -32602, message: 'Insufficient scope for tool: execute_assistant' },
    httpStatus: 200,
    keySource: 'shared',
  });

  let code;
  try {
    await run('execute-assistant', '--id', '12', '--user', 'nokey@psd401.net');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(12);
  expect(emitted[0].status).toBe('mcp-error');
  expect(emitted[0].jsonrpc_error.message).toContain('Insufficient scope');
  expect(emitted[0].hint).toContain('mcp:execute_assistant');
  expect(emitted[0].hint).toMatch(/store your own/i);
});

test('insufficient scope on a PERSONAL key → re-mint hint, exit 12', async () => {
  toolResponder = () => ({
    jsonrpcError: { code: -32602, message: 'Insufficient scope for tool: capture_decision' },
    httpStatus: 200,
    keySource: 'personal',
  });

  let code;
  try {
    await run('capture-decision', '--decision', 'D', '--decided-by', 'Cabinet', '--user', 'staff@psd401.net');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(12);
  expect(emitted[0].hint).toContain('mcp:capture_decision');
  expect(emitted[0].hint).toMatch(/mint a new/i);
});

// ── search-decisions / capture-decision / get-decision-graph ───────────────────

test('search-decisions maps --node-type/--node-class to camelCase args', async () => {
  toolResponder = () => ({ isError: false, payload: { nodes: [] }, keySource: 'shared' });
  await run('search-decisions', '--query', 'budget', '--node-type', 'decision', '--node-class', 'policy', '--limit', '10');

  expect(toolCalls[0].toolName).toBe('search_decisions');
  expect(toolCalls[0].toolArgs).toEqual({
    query: 'budget',
    nodeType: 'decision',
    nodeClass: 'policy',
    limit: 10,
  });
});

test('capture-decision maps flags to the createDecision schema shape', async () => {
  toolResponder = () => ({
    isError: false,
    payload: { decisionNodeId: 'n1', completenessScore: 0.8, warnings: ['add evidence'] },
    keySource: 'personal',
  });
  await run(
    'capture-decision',
    '--decision', 'Adopt X',
    '--decided-by', 'Cabinet',
    '--reasoning', 'because',
    '--evidence', 'a,b',
    '--alternatives', 'y,z',
    '--related-to', 'uuid-1,uuid-2',
    '--agent-id', 'agent-7'
  );

  expect(toolCalls[0].toolName).toBe('capture_decision');
  expect(toolCalls[0].toolArgs).toEqual({
    decision: 'Adopt X',
    decidedBy: 'Cabinet',
    reasoning: 'because',
    evidence: ['a', 'b'],
    alternatives_considered: ['y', 'z'],
    relatedTo: ['uuid-1', 'uuid-2'],
    agentId: 'agent-7',
  });
  // completenessScore + warnings surfaced verbatim.
  expect(emitted[0].completenessScore).toBe(0.8);
  expect(emitted[0].warnings).toEqual(['add evidence']);
});

test('capture-decision requires --decision and --decided-by (exit 1)', async () => {
  let code;
  try {
    await run('capture-decision', '--decision', 'D');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('get-decision-graph maps --node-id to nodeId', async () => {
  toolResponder = () => ({ isError: false, payload: { node: {}, connections: [] }, keySource: 'shared' });
  await run('get-decision-graph', '--node-id', 'abc-123');
  expect(toolCalls[0].toolName).toBe('get_decision_graph');
  expect(toolCalls[0].toolArgs).toEqual({ nodeId: 'abc-123' });
});

test('get-decision-graph requires --node-id (exit 1)', async () => {
  let code;
  try {
    await run('get-decision-graph');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

// ── generic ────────────────────────────────────────────────────────────────────

test('an action subcommand surfaces a tool-level isError (non-execute) as tool-error, exit 12', async () => {
  toolResponder = () => ({ isError: true, payload: 'Node not found: abc', keySource: 'shared' });
  let code;
  try {
    await run('get-decision-graph', '--node-id', 'abc');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(12);
  expect(emitted[0].status).toBe('tool-error');
  expect(emitted[0].message).toContain('Node not found');
});

test('a value-less optional flag is a usage error (exit 1)', async () => {
  let code;
  try {
    await run('list-assistants', '--search');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('an unknown subcommand fails (exit 1)', async () => {
  let code;
  try {
    await run('frobnicate');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});
