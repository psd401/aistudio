/**
 * Regression test for issue #1104 point 3: the Mantle Anthropic Messages
 * request body must include `anthropic_version` — Bedrock Mantle's Anthropic
 * path requires it and returns HTTP 400 without it.
 *
 * run.js executes at require-time (no require.main guard — it's a stdin
 * pipe-oriented script, not one with argv-driven subcommands like psd-plaud),
 * so this test drives it as a real child process, stubbing stdin and the
 * Mantle endpoint isn't possible without a live/mock HTTP server. Instead we
 * spawn a local HTTP server that captures the request body and points
 * MANTLE_ANTHROPIC_URL at it — exercising the real fetch call end-to-end.
 */

'use strict';

const { test, expect, afterEach } = require('bun:test');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

let server;
let serverPort;
let capturedBody;

function startCaptureServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        capturedBody = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          content: [{ type: 'text', text: 'summary text' }],
        }));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      serverPort = typeof address === 'object' && address ? address.port : undefined;
      resolve(server);
    });
  });
}

afterEach(() => {
  if (server) { server.close(); server = undefined; }
  serverPort = undefined;
  capturedBody = undefined;
});

function runSummarize({ stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, 'run.js')], {
      env: {
        ...process.env,
        MANTLE_ANTHROPIC_URL: `http://127.0.0.1:${serverPort}/anthropic/v1/messages`,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
    child.stdin.end(stdin);
  });
}

test('request body to Mantle includes anthropic_version alongside model/max_tokens/system/messages', async () => {
  await startCaptureServer();
  const { code, stdout, stderr } = await runSummarize({ stdin: 'Some meeting notes to summarize.' });
  expect(stderr).toBe('');
  expect(code).toBe(0);
  expect(capturedBody).toMatchObject({
    anthropic_version: 'bedrock-2023-05-31',
    model: expect.any(String),
    max_tokens: expect.any(Number),
    system: expect.any(String),
    messages: expect.any(Array),
  });
  const parsed = JSON.parse(stdout);
  expect(parsed.status).toBe('ok');
  expect(parsed.summary).toBe('summary text');
});
