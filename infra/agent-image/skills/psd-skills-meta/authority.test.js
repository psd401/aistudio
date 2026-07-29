'use strict';

const { test, expect } = require('bun:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
