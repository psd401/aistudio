'use strict';

const { test, expect } = require('bun:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const loadScript = path.resolve(__dirname, 'load.js');

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

test('load.js reads an image-bundled skill from the local catalog', () => {
  const skillsDir = path.resolve(__dirname, '..');
  const result = spawnSync(
    'node',
    [loadScript, '--name', 'psd-conversation-coach'],
    {
      encoding: 'utf8',
      env: { ...process.env, PSD_SKILLS_DIR: skillsDir },
    },
  );

  expect(result.status).toBe(0);
  const loaded = JSON.parse(result.stdout);
  expect(loaded.name).toBe('psd-conversation-coach');
  expect(loaded.skillMd).toContain('name: psd-conversation-coach');
  expect(loaded.skillMd).toContain('# PSD Conversation Coach');
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
