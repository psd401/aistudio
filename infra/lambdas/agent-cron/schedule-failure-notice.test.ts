import { describe, expect, test } from 'bun:test';
import {
  NOTICE_THRESHOLD,
  buildScheduleFailureNoticeText,
  currentFailureStreak,
  decideScheduleFailureNotice,
  isWorkspaceAuthFailure,
} from './schedule-failure-notice';
import type { ScheduleRunStatusRow } from './run-telemetry';

function row(
  status: string,
  errorMessage: string | null = null,
  ownerNotified = false,
): ScheduleRunStatusRow {
  return { status, errorMessage, ownerNotified };
}

const FAIL = () => row('error', 'Agent temporarily unavailable');
const AUTH_FAIL = () =>
  row('error', 'Workspace authorization was revoked (invalid_grant)');
/** The run that carried the owner's message. */
const NOTIFIED = (base: ScheduleRunStatusRow = FAIL()) => ({
  ...base,
  ownerNotified: true,
});

function decide(rows: readonly ScheduleRunStatusRow[]) {
  return decideScheduleFailureNotice({ rows });
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

describe('currentFailureStreak', () => {
  test('stops at the last success', () => {
    const streak = currentFailureStreak([
      FAIL(),
      FAIL(),
      row('success'),
      FAIL(),
    ]);
    expect(streak).toHaveLength(2);
  });

  test('a coalesced fire does not break a streak and is not counted', () => {
    // `skipped` means this occurrence never ran. Counting it as a failure
    // would notify on two real failures; counting it as a success would hide
    // a streak that is still running.
    expect(
      currentFailureStreak([FAIL(), row('skipped'), FAIL(), FAIL()]),
    ).toHaveLength(3);
  });

  test('an in-flight promotion is neither failure nor success', () => {
    expect(
      currentFailureStreak([row('promoted'), FAIL(), FAIL()]),
    ).toHaveLength(2);
  });

  test('a deferred delivery counts as a failed run', () => {
    expect(
      currentFailureStreak([row('deferred', 'queued for retry')]),
    ).toHaveLength(1);
  });
});

/**
 * Replay a schedule's runs in arrival order through the real rule, stamping
 * the run that carries a message exactly as the Lambda does. This is the only
 * honest way to assert "exactly one message per streak": asserting it against
 * a hand-built history bakes in whatever the rule already believes.
 */
function replay(arrivals: readonly ScheduleRunStatusRow[]): string[] {
  const history: ScheduleRunStatusRow[] = [];
  const notices: string[] = [];
  for (const run of arrivals) {
    const recorded = { ...run };
    history.unshift(recorded);
    const decision = decide(history);
    if (!decision.notify) continue;
    notices.push(decision.reason);
    recorded.ownerNotified = true;
  }
  return notices;
}

describe('decideScheduleFailureNotice — the issue #1890 acceptance tests', () => {
  test('three failed runs produce exactly one DM', () => {
    expect(replay([FAIL(), FAIL(), FAIL()])).toEqual(['streak']);
  });

  test('a fourth failure sends no new DM', () => {
    expect(replay([FAIL(), FAIL(), FAIL(), FAIL()])).toEqual(['streak']);
    // And directly: the stamped run is the suppression.
    expect(
      decide([FAIL(), NOTIFIED(), FAIL(), FAIL()]),
    ).toEqual({ notify: false });
  });

  test('a success, then three more failures, speaks again', () => {
    expect(
      replay([
        FAIL(),
        FAIL(),
        FAIL(),
        row('success'),
        FAIL(),
        FAIL(),
        FAIL(),
      ]),
    ).toEqual(['streak', 'streak']);
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
    const month = Array.from({ length: 30 }, () => FAIL());

    expect(decide(month)).toEqual({
      notify: true,
      reason: 'streak',
      consecutiveFailures: 30,
    });
  });

  test('a month-long streak still produces exactly one message', () => {
    expect(replay(Array.from({ length: 30 }, () => FAIL()))).toEqual([
      'streak',
    ]);
  });

  test('a message that failed to send is retried on the next failure', () => {
    // The rule cannot see a send failure, but it does not need to: nothing
    // was stamped, so the next failing run speaks. A length-based rule would
    // have treated the failed attempt as done and gone quiet for good.
    expect(
      decide([FAIL(), FAIL(), FAIL(), FAIL()]),
    ).toEqual({ notify: true, reason: 'streak', consecutiveFailures: 4 });
  });
});

describe('decideScheduleFailureNotice — authorization failures', () => {
  test('the first revoked-grant failure speaks immediately', () => {
    expect(decide([AUTH_FAIL()])).toEqual({
      notify: true,
      reason: 'auth',
      consecutiveFailures: 1,
    });
  });

  test('later runs in the same revoked-grant streak stay quiet', () => {
    // The real incident: a daily recap failed every weekday for over a month
    // on an expired grant. One DM, not thirty.
    expect(
      replay(Array.from({ length: 20 }, () => AUTH_FAIL())),
    ).toEqual(['auth']);
    expect(
      decide([AUTH_FAIL(), NOTIFIED(AUTH_FAIL())]),
    ).toEqual({ notify: false });
  });

  test('a success resets the authorization suppression too', () => {
    expect(
      decide([AUTH_FAIL(), row('success'), NOTIFIED(AUTH_FAIL())]),
    ).toEqual({ notify: true, reason: 'auth', consecutiveFailures: 1 });
  });

  test('an auth failure after ordinary failures still speaks', () => {
    expect(
      decide([AUTH_FAIL(), FAIL()]),
    ).toEqual({ notify: true, reason: 'auth', consecutiveFailures: 2 });
  });

  test('an ordinary failure after a reported auth failure stays quiet', () => {
    // The owner already has one DM for this streak. A second one at the
    // three-failure threshold would be the same message twice.
    expect(
      decide([FAIL(), FAIL(), NOTIFIED(AUTH_FAIL())]),
    ).toEqual({ notify: false });
  });

  test('exactly one DM across a mixed streak of any length', () => {
    expect(
      replay([
        FAIL(),
        AUTH_FAIL(),
        FAIL(),
        AUTH_FAIL(),
        FAIL(),
        FAIL(),
        FAIL(),
      ]),
    ).toEqual(['auth']);
  });

  test('the untruncated text classifies a long auth failure', () => {
    // The stored copy is capped at 500 characters; an authorization signature
    // past that cap would downgrade "speak now" to "wait three runs".
    const capped = `${'preamble '.repeat(60)}`.slice(0, 500);
    const full = `${capped}... invalid_grant`;

    expect(decide([row('error', capped)])).toEqual({ notify: false });
    expect(
      decideScheduleFailureNotice({
        rows: [row('error', capped)],
        currentErrorMessage: full,
      }),
    ).toEqual({ notify: true, reason: 'auth', consecutiveFailures: 1 });
  });
});

describe('decideScheduleFailureNotice — when there is nothing to report', () => {
  test('a successful newest run is silent even on a long past streak', () => {
    expect(
      decide([row('success'), FAIL(), FAIL(), FAIL()]),
    ).toEqual({ notify: false });
  });

  test('an empty history is silent', () => {
    expect(decide([])).toEqual({ notify: false });
  });

  test('an unclassifiable stamp suppresses rather than repeats', () => {
    // `statusRows` defaults `ownerNotified` to true when the value cannot be
    // read, so an unreadable row cannot be mistaken for "nobody was told".
    expect(
      decide([{ status: 'error', errorMessage: null, ownerNotified: true }]),
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
    expect(text).toContain('3 times in a row');
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
