/**
 * A promoted scheduled run must reach the owner notice too (#1890).
 *
 * The notice was first wired only into the cron's direct delivery path. A
 * scheduled turn that is promoted to the background job runner returns from
 * `executeLockedScheduledTurn` immediately, and its terminal error row is
 * written elsewhere — so a schedule whose runs always time out, promote, and
 * fail accumulated `error` rows, showed as failing in `psd-schedules list`,
 * and never messaged anybody. Exactly the silence the issue is about.
 *
 * The stopped-task supervisor is the hook that closes it, because ECS invokes
 * it for every stopped job task whichever side wrote the row.
 */

import { describe, expect, test } from 'bun:test';
import { agentCronTestHelpers } from './index';
import { monitorStoppedJob, type JobTaskSnapshot } from './job-monitor';
import { parseScheduledRunReconciliationMessage } from './scheduled-run-reconciliation';

const CLUSTER = 'arn:aws:ecs:us-east-1:1:cluster/agent-jobs';
const TASK = 'arn:aws:ecs:us-east-1:1:task/agent-jobs/abc123';
const CONTAINER = 'job-runner';
const FIRE_KEY = 'sched-morning#2026-10-14T13:30:00Z';

function silentLog() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sessionId: 'agent-rt-owner-build',
    lockToken: 'token',
    runtimeId: 'runtime-1',
    userEmail: 'owner@psd401.net',
    displayName: 'Owner',
    workspacePrefix: 'owner-a1b2c3d4',
    spaceName: 'spaces/owner-dm',
    scheduleId: 'sched-morning',
    scheduleName: 'Morning brief',
    scheduledRunId: '4242',
    fireKey: FIRE_KEY,
    isDM: true,
    promptExcerpt: 'brief me',
    ...overrides,
  });
}

function task(rawPayload = payload(), exitCode = 1): JobTaskSnapshot {
  return {
    taskArn: TASK,
    createdAt: new Date('2026-10-14T13:30:00Z'),
    startedAt: new Date('2026-10-14T13:30:10Z'),
    stoppedAt: new Date('2026-10-14T13:40:00Z'),
    containers: [{ name: CONTAINER, exitCode }],
    overrides: {
      containerOverrides: [
        {
          name: CONTAINER,
          environment: [{ name: 'JOB_PAYLOAD', value: rawPayload }],
        },
      ],
    },
  };
}

function stoppedEvent(exitCode = 1) {
  return {
    source: 'aws.ecs' as const,
    'detail-type': 'ECS Task State Change' as const,
    detail: {
      clusterArn: CLUSTER,
      taskArn: TASK,
      lastStatus: 'STOPPED' as const,
      stopCode: 'TaskFailedToStart',
      stoppedReason: 'container exited',
      containers: [{ name: CONTAINER, exitCode }],
    },
  };
}

function harness(options: { rawPayload?: string; exitCode?: number } = {}) {
  const notices: Array<{
    run: Record<string, unknown>;
    target: Record<string, unknown>;
  }> = [];
  const runs: Array<Record<string, unknown>> = [];
  return {
    notices,
    runs,
    async run() {
      return monitorStoppedJob(
        stoppedEvent(options.exitCode ?? 1),
        CONTAINER,
        {
          describeTask: async () =>
            task(options.rawPayload ?? payload(), options.exitCode ?? 1),
          writeRun: async (record) => {
            runs.push(record as unknown as Record<string, unknown>);
            return true;
          },
          recordFailure: async () => undefined,
          notifyOwner: async (run, target) => {
            notices.push({
              run: run as unknown as Record<string, unknown>,
              target: target as unknown as Record<string, unknown>,
            });
          },
        },
        silentLog(),
      );
    },
  };
}

describe('a promoted job that fails reaches the owner notice', () => {
  test('passes the failed run and the owner DM target from the payload', async () => {
    const { notices, runs, run } = harness();

    expect(await run()).toEqual({
      status: 'error',
      scheduleId: 'sched-morning',
    });
    expect(notices).toHaveLength(1);
    // Fired AFTER the terminal row, so the streak the notice reads includes it.
    expect(runs).toHaveLength(1);
    expect(notices[0].run).toMatchObject({
      status: 'error',
      scheduleId: 'sched-morning',
      userEmail: 'owner@psd401.net',
      fireKey: FIRE_KEY,
    });
    expect(notices[0].target).toEqual({
      dmSpaceName: 'spaces/owner-dm',
      workspacePrefix: 'owner-a1b2c3d4',
    });
  });

  test('a job that exits cleanly notifies nobody', async () => {
    const { notices, run } = harness({ exitCode: 0 });

    expect(await run()).toEqual({
      status: 'success',
      scheduleId: 'sched-morning',
    });
    expect(notices).toHaveLength(0);
  });

  test('an interactive promotion is not a schedule and is skipped', async () => {
    const { notices, run } = harness({
      rawPayload: payload({ scheduleId: undefined, scheduleName: undefined }),
    });

    expect(await run()).toEqual({ status: 'skipped', scheduleId: 'interactive' });
    expect(notices).toHaveLength(0);
  });
});

describe('the DM target is validated, never trusted', () => {
  test.each([
    ['a missing space', payload({ spaceName: undefined })],
    ['a malformed space', payload({ spaceName: 'not-a-space' })],
    ['an injected path', payload({ spaceName: 'spaces/x/messages/y' })],
    // A scheduled run always posts to the owner's own DM. Anything else would
    // put a failure notice where other people read it.
    ['a shared space', payload({ isDM: false })],
  ])('skips the notice on %s, but still records the run', async (_label, raw) => {
    const { notices, runs, run } = harness({ rawPayload: raw });

    expect(await run()).toEqual({
      status: 'error',
      scheduleId: 'sched-morning',
    });
    expect(runs).toHaveLength(1);
    expect(notices).toHaveLength(0);
  });

  test('an older payload without a prefix still notifies', async () => {
    // The prefix is only used to mint a consent link, which does not touch the
    // workspace; an empty one must not cost the owner their message.
    const { notices, run } = harness({
      rawPayload: payload({ workspacePrefix: undefined }),
    });

    await run();
    expect(notices).toHaveLength(1);
    expect(notices[0].target).toEqual({
      dmSpaceName: 'spaces/owner-dm',
      workspacePrefix: '',
    });
  });
});

describe('the reconciliation message carries the same DM target', () => {
  const base = {
    type: 'scheduled-run-reconciliation',
    scheduledRunId: '4242',
    fireKey: FIRE_KEY,
    userEmail: 'owner@psd401.net',
    scheduleId: 'sched-morning',
    scheduleName: 'Morning brief',
    sessionId: 'owner-a1b2c3d4-sched-sched-morning-2026-10-14',
    startedBy: 'scheduled-0123456789abcdef0123456789',
  };

  test('round-trips the owner DM space and workspace prefix', () => {
    expect(
      parseScheduledRunReconciliationMessage(
        JSON.stringify({
          ...base,
          dmSpaceName: 'spaces/owner-dm',
          workspacePrefix: 'owner-a1b2c3d4',
        }),
      ),
    ).toMatchObject({
      dmSpaceName: 'spaces/owner-dm',
      workspacePrefix: 'owner-a1b2c3d4',
    });
  });

  test('a message queued before these fields existed still parses', () => {
    // A rolling deploy leaves older messages in flight. Such a run is still
    // reconciled and recorded; only the courtesy message is skipped.
    const parsed = parseScheduledRunReconciliationMessage(
      JSON.stringify(base),
    );
    expect(parsed.scheduleId).toBe('sched-morning');
    expect(parsed.dmSpaceName).toBeUndefined();
  });

  test('a malformed space is dropped rather than messaged', () => {
    expect(
      parseScheduledRunReconciliationMessage(
        JSON.stringify({ ...base, dmSpaceName: 'not-a-space' }),
      ).dmSpaceName,
    ).toBeUndefined();
  });
});

describe('only a guard failure that MISSED the owner speaks', () => {
  const { guardFailureMissedTheOwner } = agentCronTestHelpers;

  test.each([
    ['fire-config'],
    ['fire-acquire'],
    ['fire-begin'],
    ['lock-config'],
    ['lock-acquire'],
    ['lock-contention'],
  ])('%s means the run never reached the owner', (phase) => {
    expect(guardFailureMissedTheOwner({ phase } as never)).toBe(true);
  });

  test.each([
    ['fire-in-progress'],
    ['fire-executing'],
    ['fire-completed'],
  ])('%s does NOT, because another invocation owns the fire', (phase) => {
    // A duplicate invocation found the fire already claimed. The owning
    // invocation can still deliver (or already did), so "has not reached
    // you" would be told minutes before the brief arrives.
    expect(guardFailureMissedTheOwner({ phase } as never)).toBe(false);
  });

  test('fire-completion does NOT, because the post already landed', () => {
    // `finalizeScheduleFire` records this when the completion marker cannot be
    // persisted AFTER the turn delivered. Worth a failure row and an alarm;
    // telling the owner a brief they just received had not arrived is not.
    expect(
      guardFailureMissedTheOwner({ phase: 'fire-completion' } as never),
    ).toBe(false);
  });

  test('lock-renew does NOT, because the turn was already under way', () => {
    expect(
      guardFailureMissedTheOwner({ phase: 'lock-renew' } as never),
    ).toBe(false);
  });

  test('an unrecognized phase stays silent rather than guessing', () => {
    // The allowlist is the point: a phase added later that fires after
    // delivery must not default to telling someone their schedule failed.
    expect(
      guardFailureMissedTheOwner({ phase: 'some-future-phase' } as never),
    ).toBe(false);
  });
});

describe('a completion-marker gap never rewrites the delivered run', () => {
  test('records a failure under the fire key and writes no run row', async () => {
    // The run row for this fire already says `success`, under the same
    // fire_key a run write would upsert onto. The gap must reach the failure
    // feed and nothing else, or a delivered brief is counted as a failed run.
    const recorded: unknown[] = [];
    const telemetry = {
      recordCronFailure: async (record: unknown) => {
        recorded.push(record);
      },
    };

    await agentCronTestHelpers.recordFireCompletionGap(
      {
        schedule: {
          ownerEmail: 'owner@psd401.net',
          scheduleId: 'sched-morning',
        },
        scheduleName: 'Morning brief',
        sessionId: 'agent-rt-owner-sched',
        runtimeSessionId: 'agent-rt-owner-sched',
        workspaceLockId: 'owner',
        startTime: 0,
        fireIdentity: { key: FIRE_KEY },
        log: silentLog(),
      } as never,
      'ConditionalCheckFailedException',
      telemetry,
    );

    expect(recorded).toEqual([
      {
        userEmail: 'owner@psd401.net',
        scheduleId: 'sched-morning',
        fireKey: FIRE_KEY,
        scheduleName: 'Morning brief',
        sessionId: 'agent-rt-owner-sched',
        errorMessage: 'ConditionalCheckFailedException',
        severity: 'error',
        context: { phase: 'fire-completion' },
      },
    ]);
  });
});
