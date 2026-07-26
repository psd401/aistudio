/**
 * Regression tests for run.js's CLI subcommand → MCP tool-argument wiring.
 *
 * Confirms the fix for issue #1104 point 1: `file`/`transcript`/`summary`
 * must call their MCP tools with the recording id under `file_id`, not `id`
 * (Plaud's MCP server rejects `id` and every content fetch previously failed).
 *
 * common.js's callTool/digestRecording/listTools are overridden on the shared
 * module.exports object BEFORE run.js is required, so run.js's top-level
 * `const { callTool, ... } = require('./common')` destructures our stubs
 * instead of hitting the network or credential broker.
 */

'use strict';

const { test, expect, beforeEach } = require('bun:test');

require('./mcp-test-support');

const common = require('./common');

let toolCalls;
let digestCalls;

// run.js destructures `const { callTool, digestRecording, listTools } =
// require('./common')` at its own module-load time below — a one-time copy
// of whatever those properties are AT THAT INSTANT. So the stubs only need
// to be in place for the duration of that require() call; common.js's shared
// module.exports object (visible to every other test file sharing Bun's
// module cache, e.g. common.test.js) is restored immediately after, while
// run.js's already-captured local bindings keep pointing at the stubs.
const originalCallTool = common.callTool;
const originalDigestRecording = common.digestRecording;
const originalListTools = common.listTools;

common.callTool = async (toolName, toolArgs) => {
  toolCalls.push({ toolName, toolArgs });
  return { ok: true };
};
common.digestRecording = async (id, opts) => {
  digestCalls.push({ id, opts });
};
common.listTools = async () => {};

const { main } = require('./run');

common.callTool = originalCallTool;
common.digestRecording = originalDigestRecording;
common.listTools = originalListTools;

beforeEach(() => {
  toolCalls = [];
  digestCalls = [];
});

async function runCli(argv) {
  process.argv = ['node', 'run.js', ...argv];
  await main();
}

test('file subcommand sends file_id (not id) to the MCP tool', async () => {
  await runCli(['file', '--id', 'rec-123']);
  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0].toolName).toBe('get_file');
  expect(toolCalls[0].toolArgs).toEqual({ file_id: 'rec-123' });
  expect(toolCalls[0].toolArgs.id).toBeUndefined();
});

test('transcript subcommand sends file_id (not id) to the MCP tool', async () => {
  await runCli(['transcript', '--id', 'rec-999']);
  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0].toolName).toBe('get_transcript');
  expect(toolCalls[0].toolArgs).toEqual({ file_id: 'rec-999' });
});

test('summary subcommand sends file_id (not id) to the MCP tool', async () => {
  await runCli(['summary', '--id', 'rec-777']);
  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0].toolName).toBe('get_note');
  expect(toolCalls[0].toolArgs).toEqual({ file_id: 'rec-777' });
});

test('digest subcommand forwards the raw --id through to digestRecording', async () => {
  await runCli(['digest', '--id', 'rec-555']);
  expect(digestCalls).toHaveLength(1);
  expect(digestCalls[0].id).toBe('rec-555');
  expect(toolCalls).toHaveLength(0); // digest never calls callTool directly
});

test('legacy --user is rejected before any Plaud operation', async () => {
  const originalExit = process.exit;
  let code;
  process.exit = (value) => {
    code = value;
    throw new Error('__exit__');
  };
  try {
    await expect(
      runCli(['--user', 'victim@psd401.net', 'whoami']),
    ).rejects.toThrow('__exit__');
  } finally {
    process.exit = originalExit;
  }
  expect(code).toBe(1);
  expect(toolCalls).toHaveLength(0);
});
