import { describe, expect, test } from 'bun:test';
import {
  NOTICE_THRESHOLD,
  buildScheduleFailureNoticeText,
  decideScheduleFailureNotice,
  isPrrCredentialFailure,
  isWorkspaceAuthFailure,
} from './schedule-failure-notice';
import {
  FAILURE_STREAK_RUN_LIMIT,
  type ScheduleFailureStreak,
} from './run-telemetry';

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
    ['your Google authorization has expired'],
    // psd-workspace's own needs-auth / revoked prose names Workspace.
    ['{"status":"needs-auth","kind":"user_account","message":"Workspace authorization is required"}'],
    ['Workspace access was revoked — click the link to re-authorize.'],
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
    // Codex P2 on PR #1925: other integrations share `needs-auth`. These must
    // not be told their Google access expired, nor handed a Workspace link.
    ['needs-auth'],
    ['{"status":"needs-auth","consent_chat_hyperlink":"<https://x|Connect your Canva account>"}'],
    ['{"status":"needs-auth","consent_chat_hyperlink":"<https://x|Connect your Plaud account>"}'],
    ['needs-auth: owner authorization is required'],
    ['click the link to re-authorize'],
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

  test('the stamp suppresses at every streak length the SQL can report', () => {
    // Codex caught this on the first draft: the suppression used to be read
    // from a fixed page of recent runs, so a schedule notified on failure 3
    // looked unnotified again by failure 15 and sent another message — roughly
    // hourly on a five-minute schedule. The streak is now aggregated over the
    // newest FAILURE_STREAK_RUN_LIMIT runs, so that is the largest count the
    // query returns; what happens past it is pinned in the PostgreSQL smoke.
    for (const consecutiveFailures of [4, 15, 300, FAILURE_STREAK_RUN_LIMIT]) {
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

  test('an auth notice promises nothing about a next run', () => {
    // An `at(...)` one-shot has no next run, and the notice cannot see the
    // expression — so it must not claim the schedule will work again.
    const text = buildScheduleFailureNoticeText({
      scheduleName: 'One-off export',
      reason: 'auth',
      consecutiveFailures: 1,
      errorMessage: 'invalid_grant',
      consentUrl: 'https://ai.psd401.net/agent-connect?token=abc',
    });

    expect(text).not.toContain('next run');
    expect(text).not.toContain('starts working again');
    expect(text).toContain('Reconnect Google Workspace');
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

  test('a saturated streak reads as a floor, not an exact total', () => {
    // The count is measured over a bounded number of runs, so at that bound it
    // is a minimum. Stating it as exact would be a number the owner could
    // check and find wrong.
    expect(
      buildScheduleFailureNoticeText({
        scheduleName: 'Morning brief',
        reason: 'streak',
        consecutiveFailures: 500,
        errorMessage: 'Agent temporarily unavailable',
      }),
    ).toContain('at least 500 runs in a row');
    expect(
      buildScheduleFailureNoticeText({
        scheduleName: 'Morning brief',
        reason: 'streak',
        consecutiveFailures: 499,
        errorMessage: 'Agent temporarily unavailable',
      }),
    ).toContain('499 runs in a row');
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

// psd-prr exits with {"status":"needs-auth","code":"prr_token_missing"|...}
// when the owner's PSD Public Records token is missing, expired, or revoked.
const PRR_REJECTED =
  '{"status":"needs-auth","kind":"prr","code":"prr_token_rejected","credentialName":"prr_pat"}';

describe('isPrrCredentialFailure', () => {
  test.each([
    [PRR_REJECTED],
    ['psd-prr: prr_token_missing'],
    ['PRR_TOKEN_REJECTED'],
  ])('matches %s', (text) => {
    expect(isPrrCredentialFailure(text)).toBe(true);
  });

  test.each([
    [null],
    [''],
    ['Agent temporarily unavailable'],
    // Another integration's needs-auth must not hand out a PRR link.
    ['{"status":"needs-auth","kind":"plaud"}'],
    // Mentioning PRR in ordinary prose is not a credential failure.
    ['PRR returned 3 overdue requests'],
  ])('does not match %s', (text) => {
    expect(isPrrCredentialFailure(text)).toBe(false);
  });
});

describe('decideScheduleFailureNotice — PRR personal token failures', () => {
  test('the first PRR token failure speaks immediately', () => {
    expect(
      decide({ consecutiveFailures: 1, newestErrorMessage: PRR_REJECTED }),
    ).toEqual({ notify: true, reason: 'prr-credential', consecutiveFailures: 1 });
  });

  test('the untruncated text classifies it too', () => {
    expect(
      decide({ consecutiveFailures: 1, newestErrorMessage: ORDINARY }, PRR_REJECTED),
    ).toEqual({ notify: true, reason: 'prr-credential', consecutiveFailures: 1 });
  });

  test('a later run in the same streak stays quiet', () => {
    expect(
      decide({
        consecutiveFailures: 5,
        alreadyNotified: true,
        newestErrorMessage: PRR_REJECTED,
      }),
    ).toEqual({ notify: false });
  });

  test('a revoked Google grant takes precedence over a PRR token failure', () => {
    expect(
      decide(
        { consecutiveFailures: 1, newestErrorMessage: PRR_REJECTED },
        `${REVOKED} ${PRR_REJECTED}`,
      ),
    ).toEqual({ notify: true, reason: 'auth', consecutiveFailures: 1 });
  });
});

describe('buildScheduleFailureNoticeText — PRR personal token', () => {
  test('carries the credential-entry link and where to create the token', () => {
    const text = buildScheduleFailureNoticeText({
      scheduleName: 'Daily PRR check',
      reason: 'prr-credential',
      consecutiveFailures: 1,
      errorMessage: PRR_REJECTED,
      consentUrl: 'https://ai.psd401.net/agent-connect-credential?token=abc',
    });

    expect(text).toContain('Daily PRR check');
    expect(text).toContain('https://prr.psd401.net/agent-access');
    expect(text).toContain(
      '<https://ai.psd401.net/agent-connect-credential?token=abc|Save your new PRR token>',
    );
    // The link is single-use and short-lived; say how to get another.
    expect(text).toContain('15 minutes');
    expect(text).not.toContain('Google');
    expect(text).not.toContain('prr_token_rejected');
  });

  test('without a link it asks the owner to request one', () => {
    const text = buildScheduleFailureNoticeText({
      scheduleName: 'Daily PRR check',
      reason: 'prr-credential',
      consecutiveFailures: 1,
      errorMessage: PRR_REJECTED,
      consentUrl: null,
    });

    expect(text).toContain('https://prr.psd401.net/agent-access');
    expect(text).toContain('ask me for a PRR token link');
    expect(text).not.toContain('<http');
  });
});
