/**
 * The streak aggregate is the load-bearing half of the owner notice (#1890).
 *
 * The decision function is trivial — it reads three numbers. Whether the
 * owner gets one message or one an hour depends entirely on this query, and
 * the first draft got it wrong by reading a fixed page of recent runs: once a
 * streak outgrew the page the run carrying the stamp fell off the end, so a
 * schedule notified on failure 3 looked unnotified by failure 15.
 */

import { describe, expect, test } from 'bun:test';
import {
  markOwnerNotified,
  readFailureStreak,
  type RunTelemetryConfig,
} from './run-telemetry';

const CONFIG: RunTelemetryConfig = {
  databaseResourceArn: 'arn:aws:rds:us-east-1:1:cluster:agent',
  databaseSecretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:agent',
  databaseName: 'aistudio',
};

const OWNER = 'owner@psd401.net';
const SCHEDULE = 'schedule-1';
const FIRE_KEY = 'schedule-1#2026-10-14T13:30:00Z';

function client(response: unknown = {}) {
  const statements: Array<{ sql: string; parameters: unknown }> = [];
  return {
    statements,
    async execute(input: { sql?: string; parameters?: unknown }) {
      statements.push({
        sql: String(input.sql ?? ''),
        parameters: input.parameters,
      });
      return response;
    },
  };
}

function streakResponse(options: {
  failures: number;
  notified?: boolean;
  newestError?: string | null;
}) {
  return {
    records: [[
      { longValue: options.failures },
      { booleanValue: options.notified ?? false },
      options.newestError === null || options.newestError === undefined
        ? { isNull: true }
        : { stringValue: options.newestError },
    ]],
  };
}

describe('readFailureStreak — the query shape', () => {
  test('bounds the streak by the schedule’s last success', async () => {
    const rds = client(streakResponse({ failures: 3 }));

    await readFailureStreak(CONFIG, rds, {
      userEmail: OWNER,
      scheduleId: SCHEDULE,
    });

    const { sql } = rds.statements[0];
    expect(sql).toContain("MAX(CASE WHEN status = 'success' THEN id END)");
    expect(sql).toContain('bound.last_success_id IS NULL');
    expect(sql).toContain('recent.id > bound.last_success_id');
  });

  test('aggregates the stamp over the WHOLE streak, with no row page', async () => {
    // This is the regression. A `LIMIT` here means the suppression is only as
    // durable as the page size, and the owner is messaged again every time
    // the stamp scrolls out of it.
    const rds = client(streakResponse({ failures: 3 }));

    await readFailureStreak(CONFIG, rds, {
      userEmail: OWNER,
      scheduleId: SCHEDULE,
    });

    const { sql } = rds.statements[0];
    expect(sql).toContain('BOOL_OR(recent.owner_notified_at IS NOT NULL)');
    expect(sql).not.toContain('LIMIT');
  });

  test('counts only failed runs, over only streak-deciding ones', async () => {
    // `skipped` and `promoted` decide nothing, and must not be counted as
    // failures NOR allowed to break a streak.
    const rds = client(streakResponse({ failures: 3 }));

    await readFailureStreak(CONFIG, rds, {
      userEmail: OWNER,
      scheduleId: SCHEDULE,
    });

    const { sql } = rds.statements[0];
    expect(sql).toContain("status IN ('success', 'error', 'deferred')");
    expect(sql).toContain("recent.status IN ('error', 'deferred')");
    expect(sql).not.toContain('skipped');
    expect(sql).not.toContain('promoted');
  });

  test('is scoped to this owner and schedule, by bound parameters', async () => {
    const rds = client(streakResponse({ failures: 1 }));

    await readFailureStreak(CONFIG, rds, {
      userEmail: OWNER,
      scheduleId: SCHEDULE,
    });

    expect(rds.statements[0].parameters).toEqual([
      { name: 'user_id', value: { stringValue: OWNER } },
      { name: 'schedule_id', value: { stringValue: SCHEDULE } },
    ]);
    expect(rds.statements[0].sql).toContain(':user_id');
    expect(rds.statements[0].sql).toContain(':schedule_id');
  });

  test('bounds the scan so a year-long streak is not read whole', async () => {
    const rds = client(streakResponse({ failures: 1 }));

    await readFailureStreak(CONFIG, rds, {
      userEmail: OWNER,
      scheduleId: SCHEDULE,
    });

    expect(rds.statements[0].sql).toContain('make_interval(');
    expect(rds.statements[0].sql).toContain('days => 90');
  });
});

describe('readFailureStreak — reading the result', () => {
  test('maps the three values the decision needs', async () => {
    const rds = client(
      streakResponse({
        failures: 7,
        notified: true,
        newestError: 'invalid_grant',
      }),
    );

    expect(
      await readFailureStreak(CONFIG, rds, {
        userEmail: OWNER,
        scheduleId: SCHEDULE,
      }),
    ).toEqual({
      consecutiveFailures: 7,
      alreadyNotified: true,
      newestErrorMessage: 'invalid_grant',
    });
  });

  test('an empty streak is never reported as notified', async () => {
    // With no rows, `BOOL_OR` is NULL and the count is 0. Reporting
    // `alreadyNotified` on an empty streak would be meaningless state.
    expect(
      await readFailureStreak(
        CONFIG,
        client(streakResponse({ failures: 0, notified: false })),
        { userEmail: OWNER, scheduleId: SCHEDULE },
      ),
    ).toEqual({
      consecutiveFailures: 0,
      alreadyNotified: false,
      newestErrorMessage: null,
    });
  });

  test('an unreadable stamp reads as notified, which suppresses', async () => {
    const rds = client({
      records: [[{ longValue: 3 }, {}, { isNull: true }]],
    });

    expect(
      (
        await readFailureStreak(CONFIG, rds, {
          userEmail: OWNER,
          scheduleId: SCHEDULE,
        })
      ).alreadyNotified,
    ).toBe(true);
  });

  test('throws rather than inventing a streak it could not read', async () => {
    // The caller treats a throw as "unreadable" and stays quiet. Returning a
    // zero here would read as "no failures" and silence a real streak.
    await expect(
      readFailureStreak(CONFIG, client({ records: [] }), {
        userEmail: OWNER,
        scheduleId: SCHEDULE,
      }),
    ).rejects.toThrow('no count');
  });

  test('refuses to run without a configured database', async () => {
    await expect(
      readFailureStreak(
        { ...CONFIG, databaseResourceArn: '' },
        client(),
        { userEmail: OWNER, scheduleId: SCHEDULE },
      ),
    ).rejects.toThrow('not configured');
  });
});

describe('markOwnerNotified', () => {
  test('stamps the exact occurrence when there is a fire key', async () => {
    const rds = client();

    await markOwnerNotified(CONFIG, rds, {
      userEmail: OWNER,
      scheduleId: SCHEDULE,
      fireKey: FIRE_KEY,
    });

    const { sql, parameters } = rds.statements[0];
    expect(sql).toContain('SET owner_notified_at = NOW()');
    expect(sql).toContain('fire_key = :fire_key');
    // Idempotent: a repeat stamp matches nothing rather than moving the time.
    expect(sql).toContain('owner_notified_at IS NULL');
    expect(parameters).toEqual([
      { name: 'user_id', value: { stringValue: OWNER } },
      { name: 'schedule_id', value: { stringValue: SCHEDULE } },
      { name: 'fire_key', value: { stringValue: FIRE_KEY } },
    ]);
  });

  test('falls back to the schedule’s newest run without a fire key', async () => {
    // A legacy invocation carries no occurrence identity; the newest run is
    // the row the caller just wrote.
    const rds = client();

    await markOwnerNotified(CONFIG, rds, {
      userEmail: OWNER,
      scheduleId: SCHEDULE,
    });

    const { sql, parameters } = rds.statements[0];
    expect(sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(sql).toContain('LIMIT 1');
    expect(sql).not.toContain(':fire_key');
    expect(parameters).toHaveLength(2);
  });

  test('always scopes the stamp to this owner and schedule', async () => {
    for (const fireKey of [FIRE_KEY, undefined]) {
      const rds = client();
      await markOwnerNotified(CONFIG, rds, {
        userEmail: OWNER,
        scheduleId: SCHEDULE,
        ...(fireKey ? { fireKey } : {}),
      });
      expect(rds.statements[0].sql).toContain('user_id = :user_id');
      expect(rds.statements[0].sql).toContain('schedule_id = :schedule_id');
    }
  });
});
