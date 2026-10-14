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
): ScheduleRunStatusRow {
  return { status, errorMessage };
}

const FAIL = () => row('error', 'Agent temporarily unavailable');
const AUTH_FAIL = () =>
  row('error', 'Workspace authorization was revoked (invalid_grant)');

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

describe('decideScheduleFailureNotice — the issue #1890 acceptance tests', () => {
  test('three failed runs produce exactly one DM', () => {
    expect(decideScheduleFailureNotice([FAIL()])).toEqual({ notify: false });
    expect(decideScheduleFailureNotice([FAIL(), FAIL()])).toEqual({
      notify: false,
    });
    expect(decideScheduleFailureNotice([FAIL(), FAIL(), FAIL()])).toEqual({
      notify: true,
      reason: 'streak',
      consecutiveFailures: 3,
    });
  });

  test('a fourth failure sends no new DM', () => {
    expect(
      decideScheduleFailureNotice([FAIL(), FAIL(), FAIL(), FAIL()]),
    ).toEqual({ notify: false });
  });

  test('a success, then three more failures, speaks again', () => {
    expect(
      decideScheduleFailureNotice([
        FAIL(),
        FAIL(),
        FAIL(),
        row('success'),
        // The pre-success streak that already earned its own DM.
        FAIL(),
        FAIL(),
        FAIL(),
        FAIL(),
      ]),
    ).toEqual({ notify: true, reason: 'streak', consecutiveFailures: 3 });
  });

  test('the threshold is the documented constant', () => {
    expect(NOTICE_THRESHOLD).toBe(3);
  });
});

describe('decideScheduleFailureNotice — authorization failures', () => {
  test('the first revoked-grant failure speaks immediately', () => {
    expect(decideScheduleFailureNotice([AUTH_FAIL()])).toEqual({
      notify: true,
      reason: 'auth',
      consecutiveFailures: 1,
    });
  });

  test('later runs in the same revoked-grant streak stay quiet', () => {
    // The real incident: a daily recap failed every weekday for over a month
    // on an expired grant. One DM, not thirty.
    expect(
      decideScheduleFailureNotice([AUTH_FAIL(), AUTH_FAIL()]),
    ).toEqual({ notify: false });
    expect(
      decideScheduleFailureNotice([AUTH_FAIL(), AUTH_FAIL(), AUTH_FAIL()]),
    ).toEqual({ notify: false });
    expect(
      decideScheduleFailureNotice([
        AUTH_FAIL(),
        AUTH_FAIL(),
        AUTH_FAIL(),
        AUTH_FAIL(),
      ]),
    ).toEqual({ notify: false });
  });

  test('a success resets the authorization suppression too', () => {
    expect(
      decideScheduleFailureNotice([AUTH_FAIL(), row('success'), AUTH_FAIL()]),
    ).toEqual({ notify: true, reason: 'auth', consecutiveFailures: 1 });
  });

  test('an auth failure after ordinary failures still speaks', () => {
    expect(
      decideScheduleFailureNotice([AUTH_FAIL(), FAIL()]),
    ).toEqual({ notify: true, reason: 'auth', consecutiveFailures: 2 });
  });

  test('an ordinary failure after a reported auth failure stays quiet', () => {
    // The owner already has one DM for this streak. A second one at the
    // three-failure threshold would be the same message twice.
    expect(
      decideScheduleFailureNotice([FAIL(), FAIL(), AUTH_FAIL()]),
    ).toEqual({ notify: false });
  });

  test('exactly one DM across a mixed streak of any length', () => {
    const history: ScheduleRunStatusRow[] = [];
    const notices: string[] = [];
    const arrivals = [
      FAIL(),
      AUTH_FAIL(),
      FAIL(),
      AUTH_FAIL(),
      FAIL(),
      FAIL(),
      FAIL(),
    ];
    for (const run of arrivals) {
      history.unshift(run);
      const decision = decideScheduleFailureNotice(history);
      if (decision.notify) notices.push(decision.reason);
    }
    // The auth failure at run 2 is the only one that speaks.
    expect(notices).toEqual(['auth']);
  });

  test('exactly one DM across a long ordinary streak', () => {
    const history: ScheduleRunStatusRow[] = [];
    const notices: string[] = [];
    for (let run = 0; run < 25; run += 1) {
      history.unshift(FAIL());
      const decision = decideScheduleFailureNotice(history);
      if (decision.notify) notices.push(decision.reason);
    }
    expect(notices).toEqual(['streak']);
  });
});

describe('decideScheduleFailureNotice — only the run just recorded speaks', () => {
  test('a successful newest run is silent even on a long past streak', () => {
    expect(
      decideScheduleFailureNotice([row('success'), FAIL(), FAIL(), FAIL()]),
    ).toEqual({ notify: false });
  });

  test('a skipped newest run is silent at the threshold', () => {
    // The fire was coalesced away, so there is no new failure to report even
    // though the streak behind it is exactly three.
    expect(
      decideScheduleFailureNotice([
        row('skipped'),
        FAIL(),
        FAIL(),
        FAIL(),
      ]),
    ).toEqual({ notify: false });
  });

  test('an empty history is silent', () => {
    expect(decideScheduleFailureNotice([])).toEqual({ notify: false });
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
