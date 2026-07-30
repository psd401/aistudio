'use strict';

const { test, expect } = require('bun:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const loadScript = path.resolve(__dirname, 'load.js');

function runLoadWithBrokerResponse(name, status, body) {
  const bootstrap = [
    `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(body))}, {`,
    `status: ${status},`,
    "headers: { 'Content-Type': 'application/json' },",
    '});',
    `process.argv = [process.execPath, ${JSON.stringify(loadScript)}, '--name', ${JSON.stringify(name)}];`,
    `require(${JSON.stringify(loadScript)});`,
  ].join('\n');
  return spawnSync('node', ['-e', bootstrap], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PSD_SKILLS_DIR: path.resolve(__dirname, '..'),
    },
  });
}

for (const script of ['search.js', 'load.js', 'author.js']) {
  test(`${script} rejects the legacy --user selector`, () => {
    const result = spawnSync(
      'node',
      [path.resolve(__dirname, script), '--user', 'victim@psd401.net'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--user is not accepted');
    expect(result.stderr).toContain('signed invocation');
  });
}

test('load.js reads an image-bundled skill after broker authorization', () => {
  const result = runLoadWithBrokerResponse(
    'psd-conversation-coach',
    200,
    { name: 'psd-conversation-coach', source: 'bundled' },
  );

  expect(result.status).toBe(0);
  const loaded = JSON.parse(result.stdout);
  expect(loaded.name).toBe('psd-conversation-coach');
  expect(loaded.skillMd).toContain('name: psd-conversation-coach');
  expect(loaded.skillMd).toContain('# PSD Conversation Coach');
});

test('load.js honors a broker denial even when the bundled file exists', () => {
  const result = runLoadWithBrokerResponse(
    'psd-conversation-coach',
    404,
    { error: 'not_found' },
  );

  expect(result.status).toBe(0);
  const denied = JSON.parse(result.stdout);
  expect(denied.error).toBe('not_found');
  expect(denied.message).toContain('not found in the catalog or not accessible');
  expect(denied).not.toHaveProperty('skillMd');
});

test('load.js rejects unsafe names before resolving a local path', () => {
  const result = spawnSync(
    'node',
    [loadScript, '--name', '../../etc'],
    { encoding: 'utf8' },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Invalid skill name');
});
