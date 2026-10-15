'use strict';

const { describe, expect, it } = require('bun:test');
const { renderLastRunStatus } = require('./list');

describe('psd-schedules list last-run rendering', () => {
  it('renders never-run and recorded states per schedule', () => {
    const result = renderLastRunStatus({
      schedules: [
        {
          scheduleId: 'never',
          lastRunAt: null,
          lastRunStatus: null,
          lastRunError: null,
        },
        {
          scheduleId: 'unavailable',
          lastRunAt: null,
          lastRunStatus: 'unknown',
          lastRunError: null,
        },
        {
          scheduleId: 'failed',
          lastRunAt: '2026-07-28T15:30:00.000Z',
          lastRunStatus: 'error',
          lastRunError: 'RunTask failed',
        },
      ],
    });

    expect(result.schedules[0].lastRunStatus).toBe('never run');
    expect(result.schedules[1].lastRunStatus).toBe('unknown');
    expect(result.schedules[2]).toMatchObject({
      lastRunStatus: 'error',
      lastRunError: 'RunTask failed',
    });
  });

});

describe('psd-schedules list failing marker', () => {
  it('renders the broker verdict rather than re-deciding it', () => {
    // #1890: `lastRunStatus: "error"` alone read like a one-off blip, so a job
    // dead for a month looked identical to one that hiccupped once. The
    // VERDICT is the server's — a second local threshold here would silently
    // overrule it the moment the two drifted.
    const result = renderLastRunStatus({
      schedules: [
        {
          scheduleId: 'healthy',
          lastRunAt: '2026-10-14T13:30:00.000Z',
          lastRunStatus: 'success',
          failing: false,
          consecutiveFailures: 0,
        },
        {
          scheduleId: 'blip',
          lastRunAt: '2026-10-14T13:30:00.000Z',
          lastRunStatus: 'error',
          failing: false,
          consecutiveFailures: 2,
        },
        {
          scheduleId: 'broken',
          lastRunAt: '2026-10-14T13:30:00.000Z',
          lastRunStatus: 'error',
          failing: true,
          consecutiveFailures: 23,
        },
      ],
    });

    expect(result.schedules[0].failing).toBe(false);
    expect(result.schedules[0].failingReason).toBeUndefined();
    expect(result.schedules[1].failing).toBe(false);
    expect(result.schedules[1].failingReason).toBeUndefined();
    expect(result.schedules[2].failing).toBe(true);
    expect(result.schedules[2].failingReason).toContain(
      '23 consecutive failed runs',
    );
  });

  it('renders a capped streak as a floor, not an exact total', () => {
    // A five-minute schedule saturates the bound in about two days, so the
    // count is a minimum. Reporting it as exact would be a number the owner
    // could check and find wrong.
    const result = renderLastRunStatus({
      schedules: [
        {
          scheduleId: 'saturated',
          lastRunAt: '2026-10-14T13:30:00.000Z',
          lastRunStatus: 'error',
          failing: true,
          consecutiveFailures: 500,
          consecutiveFailuresCapped: true,
        },
        {
          scheduleId: 'exact',
          lastRunAt: '2026-10-14T13:30:00.000Z',
          lastRunStatus: 'error',
          failing: true,
          consecutiveFailures: 499,
          consecutiveFailuresCapped: false,
        },
      ],
    });

    expect(result.schedules[0].failingReason).toContain(
      'at least 500 consecutive failed runs',
    );
    expect(result.schedules[1].failingReason).toContain(
      '499 consecutive failed runs',
    );
    expect(result.schedules[1].failingReason).not.toContain('at least');
  });

  it('never upgrades a schedule the server did not call failing', () => {
    // A high streak count with `failing: false` means the server's threshold
    // has moved. The skill follows it instead of substituting its own answer.
    const result = renderLastRunStatus({
      schedules: [
        {
          scheduleId: 'server-says-fine',
          lastRunAt: '2026-10-14T13:30:00.000Z',
          lastRunStatus: 'error',
          failing: false,
          consecutiveFailures: 99,
        },
      ],
    });

    expect(result.schedules[0].failing).toBe(false);
    expect(result.schedules[0].failingReason).toBeUndefined();
  });

  it('still reads as failing when the count is missing or unusable', () => {
    // An older broker may send the verdict without a usable count; the marker
    // must still fire, just without the number.
    const result = renderLastRunStatus({
      schedules: [
        { scheduleId: 'legacy', lastRunAt: null, lastRunStatus: null },
        {
          scheduleId: 'no-count',
          lastRunAt: '2026-10-14T13:30:00.000Z',
          lastRunStatus: 'error',
          failing: true,
        },
        {
          scheduleId: 'garbage-count',
          lastRunAt: '2026-10-14T13:30:00.000Z',
          lastRunStatus: 'error',
          failing: true,
          consecutiveFailures: 'lots',
        },
      ],
    });

    expect(result.schedules[0].failing).toBe(false);
    expect(result.schedules[1].failing).toBe(true);
    expect(result.schedules[1].failingReason).toContain(
      'consecutive failed runs',
    );
    expect(result.schedules[2].failing).toBe(true);
    expect(result.schedules[2].failingReason).not.toContain('lots');
  });

  it('reports deferred as the status the broker sent', () => {
    // SKILL.md documents `deferred` as a failure the owner has not received,
    // not as "has not run yet"; the skill must not rewrite it.
    const result = renderLastRunStatus({
      schedules: [
        {
          scheduleId: 'queued',
          lastRunAt: '2026-10-14T13:30:00.000Z',
          lastRunStatus: 'deferred',
          lastRunError: 'Chat delivery failed and was queued for retry: 503',
        },
      ],
    });

    expect(result.schedules[0].lastRunStatus).toBe('deferred');
  });

  it('passes the broker read-back fields through untouched', () => {
    // SKILL.md tells the agent to confirm from `description` and `nextRuns`
    // rather than from the cron string it typed. If list.js ever stops
    // forwarding them, that instruction quietly becomes unfollowable.
    const result = renderLastRunStatus({
      schedules: [
        {
          scheduleId: 'echoed',
          schedulerExpression: 'cron(30 6 ? * MON-FRI *)',
          description: 'At 6:30 AM, on Monday through Friday',
          nextRuns: ['2026-10-13T06:30:00-07:00'],
          lastRunAt: null,
          lastRunStatus: null,
        },
      ],
    });

    expect(result.schedules[0]).toMatchObject({
      schedulerExpression: 'cron(30 6 ? * MON-FRI *)',
      description: 'At 6:30 AM, on Monday through Friday',
      nextRuns: ['2026-10-13T06:30:00-07:00'],
    });
  });
});
