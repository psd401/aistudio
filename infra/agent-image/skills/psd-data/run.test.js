/**
 * Regression tests for run.js's `query` subcommand pre-flight validation
 * (FS#162394 / issue #1106): a bare NUMERIC/DECIMAL cast must be rejected
 * client-side, before the request ever reaches the MCP server, since the
 * server-side rejection silently drops the column from CSV exports instead
 * of surfacing a clear error.
 *
 * common.js's callMcp is overridden on the shared module.exports object
 * BEFORE run.js is required, so run.js's top-level
 * `const { callMcp, ... } = require('./common')` destructures our stub
 * instead of hitting the network/Secrets Manager. process.exit is also
 * stubbed so a `fail()` call doesn't kill the test process.
 */

'use strict';

const { test, expect, beforeEach, afterAll } = require('bun:test');

require('./mcp-test-support'); // registers the shared Secrets Manager mock

const common = require('./common');

let mcpCalls;

const originalCallMcp = common.callMcp;
common.callMcp = async (method, params, ownerEmail) => {
  mcpCalls.push({ method, params, ownerEmail });
  return { ok: true };
};

const { main } = require('./run');

common.callMcp = originalCallMcp;

const EMAIL = 'teacher@psd401.net';
const originalExit = process.exit;

beforeEach(() => {
  mcpCalls = [];
  process.exit = (code) => {
    throw Object.assign(new Error(`process.exit(${code})`), { exitCode: code });
  };
});

afterAll(() => {
  process.exit = originalExit;
});

async function runCli(argv) {
  process.argv = ['node', 'run.js', ...argv];
  await main();
}

test('query with an explicit-precision cast reaches the MCP server', async () => {
  await runCli([
    'query',
    '--user', EMAIL,
    '--reason', 'iReady score export',
    '--sql', 'SELECT CAST(score AS NUMERIC(10,2)) FROM iready_scores',
  ]);
  expect(mcpCalls).toHaveLength(1);
  expect(mcpCalls[0].params.name).toBe('query_data');
  expect(mcpCalls[0].params.arguments.sql_query).toBe(
    'SELECT CAST(score AS NUMERIC(10,2)) FROM iready_scores'
  );
});

test('query with a bare CAST(...AS NUMERIC) is rejected before hitting the MCP server', async () => {
  let thrown;
  try {
    await runCli([
      'query',
      '--user', EMAIL,
      '--reason', 'iReady score export',
      '--sql', 'SELECT CAST(score AS NUMERIC) FROM iready_scores',
      '--export',
    ]);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeDefined();
  expect(thrown.exitCode).toBe(1);
  expect(mcpCalls).toHaveLength(0); // never reached the MCP server
});

test('query with bare ::decimal shorthand is rejected before hitting the MCP server', async () => {
  let thrown;
  try {
    await runCli([
      'query',
      '--user', EMAIL,
      '--reason', 'iReady score export',
      '--sql', 'SELECT score::decimal FROM iready_scores',
      '--export',
    ]);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeDefined();
  expect(thrown.exitCode).toBe(1);
  expect(mcpCalls).toHaveLength(0);
});

test('query with no numeric casts reaches the MCP server unaffected', async () => {
  await runCli([
    'query',
    '--user', EMAIL,
    '--reason', 'Headcount sanity check',
    '--sql', 'SELECT COUNT(*) FROM students WHERE active = true',
  ]);
  expect(mcpCalls).toHaveLength(1);
  expect(mcpCalls[0].params.name).toBe('query_data');
});
