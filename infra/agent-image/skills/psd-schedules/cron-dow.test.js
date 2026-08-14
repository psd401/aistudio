/**
 * Client-side cron validation for psd-schedules.
 *
 * common.js had no test file, which is how the day-of-week rule came to exist
 * on only one of its two entry paths: an agent submitting an already-wrapped
 * `cron(...)` skipped the check entirely and learned about it only from the
 * server. Both paths are covered here.
 *
 * `fail()` calls process.exit rather than throwing, so each case runs in a
 * subprocess — the same approach authority.test.js uses.
 */

'use strict';

const { test, expect, describe } = require('bun:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function normalize(expr) {
  const script =
    `const {toSchedulerExpression}=require(${JSON.stringify(path.join(__dirname, 'common.js'))});` +
    `process.stdout.write(toSchedulerExpression(${JSON.stringify(expr)}));`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

describe('day-of-week must be named on BOTH entry paths', () => {
  test('rejects a numeric range in the unwrapped form', () => {
    // agent_failures 8157: this ran Sun-Thu for a week.
    const result = normalize('30 6 * * 1-5');
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('names');
  });

  test('rejects a numeric range in the pre-wrapped form', () => {
    // The gap: nothing in code stops an agent sending this shape.
    const result = normalize('cron(30 6 ? * 1-5 *)');
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('names');
  });

  test('the message explains the off-by-one either way', () => {
    for (const expr of ['30 6 * * 1-5', 'cron(30 6 ? * 1-5 *)']) {
      const result = normalize(expr);
      expect(result.stderr).toContain('1=SUN');
      expect(result.stderr).toContain('MON-FRI');
    }
  });

  test('accepts named days in both forms', () => {
    expect(normalize('30 6 * * MON-FRI').stdout).toBe('cron(30 6 ? * MON-FRI *)');
    expect(normalize('cron(30 6 ? * MON-FRI *)').stdout).toBe('cron(30 6 ? * MON-FRI *)');
  });

  test('leaves ? and * alone, and does not touch numeric day-of-MONTH', () => {
    expect(normalize('0 18 * * *').stdout).toBe('cron(0 18 * * ? *)');
    // 1,15 is day-of-month here — numeric, but unambiguous across dialects.
    expect(normalize('0 8 1,15 * *').stdout).toBe('cron(0 8 1,15 * ? *)');
  });
});
