'use strict';

const { describe, expect, it } = require('bun:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const skillDir = __dirname;

describe('psd-schedules authority selectors', () => {
  for (const script of ['create.js', 'list.js', 'update.js', 'delete.js']) {
    it(`${script} rejects the legacy --user selector before network access`, () => {
      const result = spawnSync(
        process.execPath,
        [path.join(skillDir, script), '--user', 'victim@psd401.net'],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--user is not accepted');
      expect(result.stderr).toContain('signed invocation context');
    });
  }
});
