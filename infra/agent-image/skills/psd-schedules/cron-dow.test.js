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

describe('an unwrapped 6-field cron must carry a YEAR in field 6', () => {
  test('rejects the seconds-first daily form that became a monthly schedule', () => {
    // #1888: "6:15pm daily". Six fields, year slot `*`, so every count and
    // bound check passed — and normalizeUnwrappedCron then set `?` itself,
    // producing cron(0 15 18 * ? *): 3:00pm on the 18th of every month.
    const result = normalize('0 15 18 * * *');
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('seconds-first');
    expect(result.stderr).toContain('15 18 * * *');
  });

  test('rejects the seconds-first morning form', () => {
    const result = normalize('0 30 6 * * *');
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('seconds-first');
  });

  test('rejects a seconds-first form whose seconds are not zero', () => {
    // The check once required field 1 to be `0`, which let every nonzero
    // seconds value through: `30 15 18 * * *` (6:15:30pm daily) normalized to
    // cron(30 15 18 * ? *) — 3:30pm on the 18th. Mirrors the server test in
    // tests/unit/agent-schedules-cron-domains.test.ts.
    const result = normalize('30 15 18 * * *');
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('seconds-first');
    expect(result.stderr).toContain('day-of-month 18');

    const morning = normalize('45 30 6 * * *');
    expect(morning.ok).toBe(false);
    expect(morning.stderr).toContain('seconds-first');
  });

  test('rejects a 6th field that is neither a year nor *', () => {
    const unwrapped = normalize('0 45 6 * ? MON-FRI');
    expect(unwrapped.ok).toBe(false);
    expect(unwrapped.stderr).toContain('4-digit year');

    // Same rule on the pre-wrapped path, so neither entry point is the soft one.
    const wrapped = normalize('cron(45 6 ? * * JAN)');
    expect(wrapped.ok).toBe(false);
    expect(wrapped.stderr).toContain('4-digit year');
  });

  test('still accepts a valid 5-field cron', () => {
    const result = normalize('30 6 * * MON-FRI');
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('cron(30 6 ? * MON-FRI *)');
  });

  test('still accepts a valid wrapped 6-field cron', () => {
    expect(normalize('cron(15 18 * * ? *)').stdout).toBe('cron(15 18 * * ? *)');
    expect(normalize('cron(0 6 ? * MON-FRI 2027)').stdout).toBe(
      'cron(0 6 ? * MON-FRI 2027)',
    );
  });

  test('leaves a legitimate unwrapped 6-field expression alone', () => {
    // Field 1 is `0` and field 3 is hour-sized — the seconds-first
    // fingerprint — but `?` in day-of-week says this really is EventBridge
    // shape, so it must stay accepted.
    expect(normalize('0 0 1 * ? *').stdout).toBe('cron(0 0 1 * ? *)');
    expect(normalize('45 6 ? * MON-FRI *').stdout).toBe(
      'cron(45 6 ? * MON-FRI *)',
    );
  });

  test('keeps an explicit-year expression that matches the seconds fingerprint', () => {
    // 9:00am on the 1st, in 2027. A seconds-first cron carries day-of-week in
    // field 6, never a 4-digit year, so this form is not ambiguous.
    expect(normalize('0 9 1 * * 2027').stdout).toBe('cron(0 9 1 * ? 2027)');
  });
});

describe('the hand-wrapped cron path enforces the same rules as the server', () => {
  test('rejects a wrapped expression with no ? in either day field', () => {
    // cron(0 15 18 * * *) reads to EventBridge as 15:00 on the 18th. The
    // unwrapped path was guarded and this one was not, so an agent that
    // wrapped the expression itself learned the rule only from the broker.
    const result = normalize('cron(0 15 18 * * *)');
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('? in exactly one');
  });

  test('still accepts a wrapped expression with ? in exactly one day field', () => {
    expect(normalize('cron(0 8 1,15 * ? *)').stdout).toBe(
      'cron(0 8 1,15 * ? *)',
    );
    expect(normalize('cron(0 9 ? * MON *)').stdout).toBe('cron(0 9 ? * MON *)');
  });
});

describe('the wrapped path bounds its numeric fields locally', () => {
  test('rejects out-of-range values without a broker round trip', () => {
    expect(normalize('cron(99 6 ? * MON *)').stderr).toContain('minute');
    expect(normalize('cron(0 99 ? * MON *)').stderr).toContain('hour');
    expect(normalize('cron(0 6 45 * ? *)').stderr).toContain('day-of-month');
    expect(normalize('cron(0 6 ? 13 * *)').stderr).toContain('month');
  });

  test('leaves in-range wrapped expressions alone', () => {
    expect(normalize('cron(59 23 ? * SAT *)').stdout).toBe(
      'cron(59 23 ? * SAT *)',
    );
    expect(normalize('cron(0 0 31 12 ? *)').stdout).toBe('cron(0 0 31 12 ? *)');
  });
});
