/**
 * request_entry.js — one-time credential entry link (issue #1887).
 *
 * This command is the ONLY sanctioned way for an agent to obtain a secret from
 * a user. ~15 staff pasted Freshservice API keys into chat because the old
 * flow asked them to, so the tests below pin the two things that keep the
 * value out of the agent's hands: the command refuses to carry a value at all,
 * and what it emits is a link plus instructions never to ask for a paste.
 *
 * The happy path runs the real CLI against a stub standing in for the local
 * authority relay, so the request shape is verified end to end rather than
 * mocked at the module boundary.
 */

'use strict';

const {
  test,
  expect,
  afterEach,
} = require('bun:test');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, 'request_entry.js');
// Must match brokerUrl() in ../_shared/agent-broker.js.
const RELAY_PORT = 18791;
const ENTRY_URL =
  'https://app.test/agent-connect-credential?token=signed.consent.token';

let server = null;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});

/**
 * Stand in for the local authority relay; records what the CLI sent.
 *
 * `handler(path, body)` returns `[status, payload]`. Plain node:http rather
 * than Bun.serve so the file stays runnable (and lintable) as ordinary CJS.
 */
async function startRelay(handler) {
  const seen = [];
  server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      seen.push({ path: request.url, body });
      const [status, payload] = handler(request.url, body);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(RELAY_PORT, '127.0.0.1', resolve);
  });
  return seen;
}

function run(args) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: process.env,
  });
}

test('mints a credential_entry link through the consent-link route', async () => {
  const seen = await startRelay(() => [200, { url: ENTRY_URL }]);

  const result = run([
    '--name',
    'freshservice_api_key',
    '--label',
    'Freshservice personal API key',
  ]);

  expect(result.status).toBe(0);
  expect(seen).toHaveLength(1);
  expect(seen[0].path).toBe('/agent-broker/api/agent/consent-link');
  // kind + name only — no identity, and nothing that could carry a secret.
  expect(seen[0].body).toEqual({
    kind: 'credential_entry',
    name: 'freshservice_api_key',
  });

  const emitted = JSON.parse(result.stdout);
  expect(emitted.url).toBe(ENTRY_URL);
  expect(emitted.credentialName).toBe('freshservice_api_key');
  expect(emitted.expiresInMinutes).toBe(15);
  expect(emitted.label).toBe('Freshservice personal API key');
});

test('tells the agent how to send the link and not to ask for a paste', async () => {
  await startRelay(() => [200, { url: ENTRY_URL }]);

  const emitted = JSON.parse(run(['--name', 'openai_api_key']).stdout);
  const instructions = emitted.chatInstructions.join(' ');

  // Markdown around the link corrupts the JWT in Google Chat (incident
  // 2026-04-27), so the emitted guidance has to say so.
  expect(instructions).toContain('line by itself');
  expect(instructions).toContain('no markdown');
  expect(instructions).toMatch(/15 minutes/);
  expect(instructions).toMatch(/do NOT ask them to paste the value into chat/i);
  // The label defaults to the slot name when none is given.
  expect(emitted.label).toBe('openai_api_key');
});

test('refuses to carry a value — the user types it into the page', async () => {
  const seen = await startRelay(() => [200, { url: ENTRY_URL }]);

  const result = run(['--name', 'freshservice_api_key', '--value', 'sk-leaked']);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--value is not accepted');
  // Nothing was sent, so the value never left this process.
  expect(seen).toHaveLength(0);
  expect(result.stdout).not.toContain('sk-leaked');
});

test.each([
  ['no name at all', []],
  ['a path-traversal name', ['--name', '../../shared/openai']],
  ['a name with a slash', ['--name', 'user/freshservice']],
])('rejects %s before contacting the relay', async (_label, args) => {
  const seen = await startRelay(() => [200, { url: ENTRY_URL }]);

  const result = run(args);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Invalid credential name');
  expect(seen).toHaveLength(0);
});

test('fails closed when the relay refuses', async () => {
  await startRelay(() => [429, { error: 'Rate limit exceeded' }]);

  const result = run(['--name', 'freshservice_api_key']);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Failed to mint credential entry link');
  expect(result.stderr).toContain('Rate limit exceeded');
  expect(result.stdout).toBe('');
});

test('fails closed when the relay returns no url', async () => {
  await startRelay(() => [200, { ok: true }]);

  const result = run(['--name', 'freshservice_api_key']);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('no entry link');
});
