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

  it('marks a schedule failing once the streak reaches three', () => {
    // #1890: `lastRunStatus: "error"` alone read like a one-off blip, so a job
    // dead for a month looked identical to one that hiccupped once.
    const result = renderLastRunStatus({
      schedules: [
        {
          scheduleId: 'healthy',
          lastRunAt: '2026-10-14T13:30:00.000Z',
          lastRunStatus: 'success',
          consecutiveFailures: 0,
        },
        {
          scheduleId: 'blip',
          lastRunAt: '2026-10-14T13:30:00.000Z',
          lastRunStatus: 'error',
          consecutiveFailures: 2,
        },
        {
          scheduleId: 'broken',
          lastRunAt: '2026-10-14T13:30:00.000Z',
          lastRunStatus: 'error',
          consecutiveFailures: 23,
        },
      ],
    });

    expect(result.schedules[0].failing).toBe(false);
    expect(result.schedules[0].failingReason).toBeUndefined();
    expect(result.schedules[1].failing).toBe(false);
    expect(result.schedules[2].failing).toBe(true);
    expect(result.schedules[2].failingReason).toContain(
      '23 consecutive failed runs',
    );
  });

  it('reports not-failing when the streak count is missing or unusable', () => {
    // An older broker that does not send the field must not make every
    // schedule look broken.
    const result = renderLastRunStatus({
      schedules: [
        { scheduleId: 'legacy', lastRunAt: null, lastRunStatus: null },
        {
          scheduleId: 'garbage',
          lastRunAt: null,
          lastRunStatus: null,
          consecutiveFailures: 'lots',
        },
      ],
    });

    expect(result.schedules[0].failing).toBe(false);
    expect(result.schedules[1].failing).toBe(false);
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
