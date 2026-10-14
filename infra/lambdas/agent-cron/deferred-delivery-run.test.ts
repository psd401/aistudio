/**
 * #1890: a queued retry must not be recorded as success, and the owner has to
 * hear about a schedule that keeps failing.
 *
 * These drive the real `deliverScheduledResultWithDependencies` wiring, not
 * the decision helper in isolation — the bug was that the direct path recorded
 * success while the Chat post sat on a queue, which every test of the helper
 * alone would still have passed.
 */

import { describe, expect, test } from 'bun:test';
import { agentCronTestHelpers } from './index';
import type { ScheduleFailureStreak } from './run-telemetry';

const {
  deliverScheduledResultWithDependencies,
  toInvokeResult,
  buildScheduledChatDeliveryEnvelope,
} = agentCronTestHelpers;

function silentLog() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

const FIRE_KEY = 'sched-morning#2026-10-14T13:30:00Z';

function context(options: { fireKey?: string | null; ok?: boolean } = {}) {
  const response = options.ok === false ? '' : 'Here is your brief.';
  return {
    schedule: {
      scheduleId: 'sched-morning',
      ownerEmail: 'owner@psd401.net',
      dmSpaceName: 'spaces/owner-dm',
      workspacePrefix: 'owner-a1b2c3d4',
    },
    scheduleName: 'Morning brief',
    startTime: Date.now(),
    sessionId: 'owner-a1b2c3d4-sched-sched-morning-2026-10-14',
    runtimeSessionId: 'agent-rt-x',
    workspaceLockId: 'agent-workspace-x',
    fireIdentity:
      options.fireKey === null
        ? null
        : { key: options.fireKey ?? FIRE_KEY, scheduledTime: '2026-10-14T13:30:00Z' },
    result: toInvokeResult({ result: response, metadata: {} }),
    log: silentLog(),
  } as never;
}

interface Recorded {
  runs: Array<Record<string, unknown>>;
  enqueued: Array<unknown[]>;
  dms: string[];
  consentCalls: number;
  notifiedStamps: Array<Record<string, unknown>>;
}

function dependencies(
  options: {
    sendFails?: boolean;
    enqueueFails?: boolean;
    streak?: Partial<ScheduleFailureStreak> | null;
    consentUrl?: string | null;
  } = {},
) {
  const recorded: Recorded = {
    runs: [],
    enqueued: [],
    dms: [],
    consentCalls: 0,
    notifiedStamps: [],
  };
  return {
    recorded,
    deps: {
      sendPreparedChatMessage: (async () => {
        if (options.sendFails) throw new Error('Chat unavailable (503)');
        return 'spaces/owner-dm/threads/brief';
      }) as never,
      recordThreadSession: (async () => true) as never,
      enqueueScheduledChatDelivery: (async (...args: unknown[]) => {
        if (options.enqueueFails) throw new Error('SQS unavailable');
        recorded.enqueued.push(args);
      }) as never,
      recordRun: (async (params: Record<string, unknown>) => {
        recorded.runs.push(params);
      }) as never,
      failureStreak: (async () =>
        options.streak
          ? {
            consecutiveFailures: 0,
            alreadyNotified: false,
            newestErrorMessage: null,
            ...options.streak,
          }
          : null) as never,
      markOwnerNotified: (async (params: Record<string, unknown>) => {
        recorded.notifiedStamps.push(params);
      }) as never,
      sendChatMessage: (async (
        _space: string,
        text: string,
      ) => {
        recorded.dms.push(text);
        return null;
      }) as never,
      mintOwnerConsentLink: (async () => {
        recorded.consentCalls += 1;
        return options.consentUrl ?? null;
      }) as never,
    },
  };
}

describe('a queued Chat retry is recorded as deferred, not success', () => {
  test('the run row says deferred and names the delivery failure', async () => {
    const { recorded, deps } = dependencies({ sendFails: true });

    const outcome = await deliverScheduledResultWithDependencies(
      context(),
      deps,
    );

    expect(recorded.runs).toHaveLength(1);
    expect(recorded.runs[0]).toMatchObject({
      status: 'deferred',
      fireKey: FIRE_KEY,
      scheduleId: 'sched-morning',
      userEmail: 'owner@psd401.net',
    });
    expect(recorded.runs[0].errorMessage).toContain(
      'Chat delivery failed and was queued for retry',
    );
    expect(recorded.runs[0].errorMessage).toContain('Chat unavailable (503)');
    // Not reported as a completed run either.
    expect(outcome).toEqual({ status: 'error', scheduleId: 'sched-morning' });
  });

  test('the fire key travels with the queued post so it can be resolved', async () => {
    const { recorded, deps } = dependencies({ sendFails: true });

    await deliverScheduledResultWithDependencies(context(), deps);

    expect(recorded.enqueued).toHaveLength(1);
    expect(recorded.enqueued[0][4]).toBe(FIRE_KEY);
  });

  test('a fire with no occurrence identity still records deferred', async () => {
    const { recorded, deps } = dependencies({ sendFails: true });

    await deliverScheduledResultWithDependencies(
      context({ fireKey: null }),
      deps,
    );

    expect(recorded.runs[0]).toMatchObject({ status: 'deferred' });
    // No key to resolve by, so the envelope omits it — the row stays
    // `deferred`, which is still truthful.
    expect(recorded.enqueued[0][4]).toBeUndefined();
  });

  test('a delivery that also fails to enqueue stays an outright error', async () => {
    const { recorded, deps } = dependencies({
      sendFails: true,
      enqueueFails: true,
    });

    const outcome = await deliverScheduledResultWithDependencies(
      context(),
      deps,
    );

    expect(recorded.runs).toHaveLength(1);
    expect(recorded.runs[0]).toMatchObject({ status: 'error' });
    expect(outcome).toEqual({ status: 'error', scheduleId: 'sched-morning' });
  });

  test('a delivered post is still recorded as success', async () => {
    const { recorded, deps } = dependencies();

    const outcome = await deliverScheduledResultWithDependencies(
      context(),
      deps,
    );

    expect(recorded.enqueued).toHaveLength(0);
    expect(recorded.runs[0]).toMatchObject({ status: 'success' });
    expect(outcome).toEqual({ status: 'success', scheduleId: 'sched-morning' });
  });
});

describe('the delivery envelope carries the scheduled-run reference', () => {
  const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

  test('includes the fire key when there is one', () => {
    expect(
      JSON.parse(
        buildScheduledChatDeliveryEnvelope(
          'spaces/AAAA',
          'scheduled answer',
          REQUEST_ID,
          FIRE_KEY,
        ),
      ),
    ).toMatchObject({ scheduledRun: { fireKey: FIRE_KEY } });
  });

  test('omits the key entirely rather than sending null', () => {
    // The router parses this envelope with a strict key allowlist; a `null`
    // would be a shape it rejects, dropping a reply the owner is waiting for.
    expect(
      JSON.parse(
        buildScheduledChatDeliveryEnvelope(
          'spaces/AAAA',
          'scheduled answer',
          REQUEST_ID,
        ),
      ),
    ).not.toHaveProperty('scheduledRun');
  });
});

describe('the owner hears about a schedule that keeps failing', () => {
  const ORDINARY = 'Agent temporarily unavailable';

  test('a third consecutive failure sends one DM naming the schedule', async () => {
    const { recorded, deps } = dependencies({
      streak: { consecutiveFailures: 3, newestErrorMessage: ORDINARY },
    });

    await deliverScheduledResultWithDependencies(
      context({ ok: false }),
      deps,
    );

    expect(recorded.runs[0]).toMatchObject({ status: 'error' });
    expect(recorded.dms).toHaveLength(1);
    expect(recorded.dms[0]).toContain('Morning brief');
    expect(recorded.dms[0]).toContain('3 times in a row');
    expect(recorded.dms[0]).toContain('ask your agent to check this schedule');
    // No consent link is minted for a non-authorization failure.
    expect(recorded.consentCalls).toBe(0);
    // Stamped with THIS fire, so the next failure stays quiet.
    expect(recorded.notifiedStamps).toEqual([
      {
        userEmail: 'owner@psd401.net',
        scheduleId: 'sched-morning',
        fireKey: FIRE_KEY,
      },
    ]);
  });

  test('a revoked grant sends a DM with the consent link', async () => {
    const { recorded, deps } = dependencies({
      streak: {
        consecutiveFailures: 1,
        newestErrorMessage: 'Workspace authorization was revoked',
      },
      consentUrl: 'https://ai.psd401.net/agent-connect?token=abc',
    });

    await deliverScheduledResultWithDependencies(
      context({ ok: false }),
      deps,
    );

    expect(recorded.consentCalls).toBe(1);
    expect(recorded.dms).toHaveLength(1);
    expect(recorded.dms[0]).toContain(
      '<https://ai.psd401.net/agent-connect?token=abc|Reconnect Google Workspace>',
    );
  });

  test('a failure after the owner was told sends nothing', async () => {
    const { recorded, deps } = dependencies({
      streak: {
        consecutiveFailures: 4,
        alreadyNotified: true,
        newestErrorMessage: ORDINARY,
      },
    });

    await deliverScheduledResultWithDependencies(
      context({ ok: false }),
      deps,
    );

    expect(recorded.dms).toHaveLength(0);
    expect(recorded.notifiedStamps).toHaveLength(0);
  });

  test('a send that throws leaves the run unstamped, so it retries', async () => {
    // The stamp is the suppression. Writing it before the send landed would
    // silence the schedule on a message nobody received.
    const { recorded, deps } = dependencies({
      streak: { consecutiveFailures: 3, newestErrorMessage: ORDINARY },
    });
    const failingDeps = {
      ...deps,
      sendChatMessage: (async () => {
        throw new Error('Chat unavailable');
      }) as never,
    };

    const outcome = await deliverScheduledResultWithDependencies(
      context({ ok: false }),
      failingDeps,
    );

    // The run itself is unaffected, and nothing was stamped.
    expect(outcome).toEqual({ status: 'error', scheduleId: 'sched-morning' });
    expect(recorded.runs).toHaveLength(1);
    expect(recorded.notifiedStamps).toHaveLength(0);
  });

  test('a deferred delivery can be the run that trips the threshold', async () => {
    const { recorded, deps } = dependencies({
      sendFails: true,
      streak: {
        consecutiveFailures: 3,
        newestErrorMessage: 'Chat delivery failed and was queued for retry',
      },
    });

    await deliverScheduledResultWithDependencies(context(), deps);

    expect(recorded.runs[0]).toMatchObject({ status: 'deferred' });
    expect(recorded.dms).toHaveLength(1);
  });

  test('an unreadable streak stays silent rather than guessing', async () => {
    // `null` is "cannot read the rows". Treating it as "no failures" would be
    // wrong in one direction and "all failures" in the other; silence is the
    // only reading that cannot invent a message.
    const { recorded, deps } = dependencies({ streak: null });

    await deliverScheduledResultWithDependencies(
      context({ ok: false }),
      deps,
    );

    expect(recorded.runs[0]).toMatchObject({ status: 'error' });
    expect(recorded.dms).toHaveLength(0);
  });

  test('a successful run never messages the owner', async () => {
    const { recorded, deps } = dependencies({
      streak: { consecutiveFailures: 3, newestErrorMessage: ORDINARY },
    });

    await deliverScheduledResultWithDependencies(context(), deps);

    expect(recorded.runs[0]).toMatchObject({ status: 'success' });
    expect(recorded.dms).toHaveLength(0);
  });
});
