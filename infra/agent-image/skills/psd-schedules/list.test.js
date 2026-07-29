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
