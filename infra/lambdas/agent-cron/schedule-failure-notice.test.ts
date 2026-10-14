import { describe, expect, test } from 'bun:test';
import {
  NOTICE_THRESHOLD,
  buildScheduleFailureNoticeText,
  decideScheduleFailureNotice,
  isWorkspaceAuthFailure,
} from './schedule-failure-notice';
import type { ScheduleFailureStreak } from './run-telemetry';

const ORDINARY = 'Agent temporarily unavailable';
const REVOKED = 'Workspace authorization was revoked (invalid_grant)';

function streak(
  overrides: Partial<ScheduleFailureStreak> = {},
): ScheduleFailureStreak {
  return {
    consecutiveFailures: 0,
    alreadyNotified: false,
    newestErrorMessage: null,
    ...overrides,
  };
}

function decide(
  overrides: Partial<ScheduleFailureStreak>,
  currentErrorMessage?: string | null,
) {
  return decideScheduleFailureNotice({
    streak: streak(overrides),
    ...(currentErrorMessage === undefined ? {} : { currentErrorMessage }),
  });
}

describe('isWorkspaceAuthFailure', () => {
  test.each([
    ['invalid_grant'],
    ['Workspace authorization was revoked'],
    ['Workspace authorization is required'],
    ['status=token-revoked'],
    ['needs-auth'],
    ['your Google authorization has expired'],
    ['click the link to re-authorize'],
  ])('matches %p', (text) => {
    expect(isWorkspaceAuthFailure(text)).toBe(true);
  });

  test.each([
    [null],
    [undefined],
    [''],
    ['Agent temporarily unavailable for scheduled task'],
    ['This scheduled task ran out of time before it could finish.'],
    ['Chat delivery failed and was queued for retry: 503'],
  ])('does not match %p', (text) => {
    expect(isWorkspaceAuthFailure(text)).toBe(false);
  });
});

describe('decideScheduleFailureNotice — the issue #1890 acceptance tests', () => {
  test('a third consecutive failure earns the DM', () => {
    expect(
      decide({ consecutiveFailures: 1, newestErrorMessage: ORDINARY }),
    ).toEqual({ notify: false });
    expect(
      decide({ consecutiveFailures: 2, newestErrorMessage: ORDINARY }),
    ).toEqual({ notify: false });
    expect(
      decide({ consecutiveFailures: 3, newestErrorMessage: ORDINARY }),
    ).toEqual({ notify: true, reason: 'streak', consecutiveFailures: 3 });
  });

  test('a failure after the owner was told sends nothing', () => {
    expect(
      decide({
        consecutiveFailures: 4,
        alreadyNotified: true,
        newestErrorMessage: ORDINARY,
      }),
    ).toEqual({ notify: false });
  });

  test('the stamp suppresses at ANY streak length, not just the next one', () => {
    // Codex caught this on the first draft: the suppression used to be read
    // from a fixed page of recent runs, so a schedule notified on failure 3
    // looked unnotified again by failure 15 and sent another message — roughly
    // hourly on a five-minute schedule. The streak is now aggregated whole.
    for (const consecutiveFailures of [4, 15, 300, 10_000]) {
      expect(
        decide({
          consecutiveFailures,
          alreadyNotified: true,
          newestErrorMessage: ORDINARY,
        }),
      ).toEqual({ notify: false });
    }
  });

  test('a success resets the streak, so three more failures speak again', () => {
    // A success empties the streak, which is what clears `alreadyNotified`:
    // the stamp sat on a run that is no longer in it.
    expect(decide({ consecutiveFailures: 0 })).toEqual({ notify: false });
    expect(
      decide({ consecutiveFailures: 3, newestErrorMessage: ORDINARY }),
    ).toEqual({ notify: true, reason: 'streak', consecutiveFailures: 3 });
  });

  test('the threshold is the documented constant', () => {
    expect(NOTICE_THRESHOLD).toBe(3);
  });
});

describe('decideScheduleFailureNotice — a streak that predates the rule', () => {
  test('a schedule already failing for a month still gets its message', () => {
    // THE headline case. ~30 staff had a standing job failing for weeks when
    // this shipped; their very next run sits on a streak far longer than the
    // threshold with nothing stamped. An earlier version inferred "already
    // told" from streak LENGTH and so skipped exactly this population.
    expect(
      decide({ consecutiveFailures: 30, newestErrorMessage: ORDINARY }),
    ).toEqual({ notify: true, reason: 'streak', consecutiveFailures: 30 });
  });

  test('a message that failed to send is retried on the next failure', () => {
    // The rule cannot see a send failure, but it does not need to: nothing
    // was stamped, so the next failing run speaks. A length-based rule would
    // have treated the failed attempt as done and gone quiet for good.
    expect(
      decide({ consecutiveFailures: 4, newestErrorMessage: ORDINARY }),
    ).toEqual({ notify: true, reason: 'streak', consecutiveFailures: 4 });
  });
});

describe('decideScheduleFailureNotice — authorization failures', () => {
  test('the first revoked-grant failure speaks immediately', () => {
    expect(
      decide({ consecutiveFailures: 1, newestErrorMessage: REVOKED }),
    ).toEqual({ notify: true, reason: 'auth', consecutiveFailures: 1 });
  });

  test('later runs in the same revoked-grant streak stay quiet', () => {
    // The real incident: a daily recap failed every weekday for over a month
    // on an expired grant. One DM, not thirty.
    expect(
      decide({
        consecutiveFailures: 20,
        alreadyNotified: true,
        newestErrorMessage: REVOKED,
      }),
    ).toEqual({ notify: false });
  });

  test('an auth failure partway into an ordinary streak still speaks', () => {
    expect(
      decide({ consecutiveFailures: 2, newestErrorMessage: REVOKED }),
    ).toEqual({ notify: true, reason: 'auth', consecutiveFailures: 2 });
  });

  test('the untruncated text classifies a long auth failure', () => {
    // The stored copy is capped at 500 characters; an authorization signature
    // past that cap would downgrade "speak now" to "wait three runs".
    const capped = 'preamble '.repeat(60).slice(0, 500);

    expect(
      decide({ consecutiveFailures: 1, newestErrorMessage: capped }),
    ).toEqual({ notify: false });
    expect(
      decide(
        { consecutiveFailures: 1, newestErrorMessage: capped },
        `${capped}... invalid_grant`,
      ),
    ).toEqual({ notify: true, reason: 'auth', consecutiveFailures: 1 });
  });
});

describe('decideScheduleFailureNotice — when there is nothing to report', () => {
  test('an empty streak is silent however long the past one was', () => {
    expect(decide({ consecutiveFailures: 0, alreadyNotified: false })).toEqual({
      notify: false,
    });
  });

  test('an unreadable stamp suppresses rather than repeats', () => {
    // `streakFromResult` defaults `alreadyNotified` to true when the value
    // cannot be read, so an unreadable row is never taken as "nobody knows".
    expect(
      decide({
        consecutiveFailures: 3,
        alreadyNotified: true,
        newestErrorMessage: null,
      }),
    ).toEqual({ notify: false });
  });
});

describe('buildScheduleFailureNoticeText', () => {
  test('an auth notice carries the consent link as a Chat hyperlink', () => {
    const text = buildScheduleFailureNoticeText({
      scheduleName: 'Daily recap',
      reason: 'auth',
      consecutiveFailures: 1,
      errorMessage: 'invalid_grant',
      consentUrl: 'https://ai.psd401.net/agent-connect?token=abc',
    });

    expect(text).toContain('Daily recap');
    expect(text).toContain(
      '<https://ai.psd401.net/agent-connect?token=abc|Reconnect Google Workspace>',
    );
    // The raw diagnostic is for the agent, not the teacher.
    expect(text).not.toContain('invalid_grant');
  });

  test('an auth notice without a link falls back to asking the agent', () => {
    const text = buildScheduleFailureNoticeText({
      scheduleName: 'Daily recap',
      reason: 'auth',
      consecutiveFailures: 1,
      errorMessage: 'invalid_grant',
      consentUrl: null,
    });

    expect(text).toContain('reconnect your Google Workspace account');
    expect(text).not.toContain('<http');
  });

  test('a streak notice names the count and the reason', () => {
    const text = buildScheduleFailureNoticeText({
      scheduleName: 'Morning brief',
      reason: 'streak',
      consecutiveFailures: 3,
      errorMessage: 'Agent temporarily unavailable',
    });

    expect(text).toContain('Morning brief');
    expect(text).toContain('3 runs in a row');
    expect(text).toContain('Agent temporarily unavailable');
    expect(text).toContain('ask your agent to check this schedule');
  });

  test('a streak notice with no recorded reason still reads as prose', () => {
    const text = buildScheduleFailureNoticeText({
      scheduleName: 'Morning brief',
      reason: 'streak',
      consecutiveFailures: 3,
      errorMessage: null,
    });

    expect(text).toContain('The run ended without a usable result.');
  });

  test('a very long diagnostic is truncated, not pasted whole', () => {
    const text = buildScheduleFailureNoticeText({
      scheduleName: 'Morning brief',
      reason: 'streak',
      consecutiveFailures: 3,
      errorMessage: 'x'.repeat(2000),
    });

    expect(text).toContain('…');
    expect(text.length).toBeLessThan(900);
  });
});
