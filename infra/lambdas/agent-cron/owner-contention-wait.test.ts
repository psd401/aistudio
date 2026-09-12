import { describe, expect, it } from 'bun:test';
import { isOwnerWorkspaceContention } from './index';
import type { JobLockFailure } from './job-lock';

/**
 * The wait exists because Scheduler's retry budget is shorter than an agent
 * turn: 5 attempts over ~3 minutes against a turn that runs 4-15. A fire that
 * lost the owner workspace lock therefore always died before the holder could
 * finish, and went to the DLQ — 247 of them by 2026-09-12, plus the
 * superintendent's Weekly Brief on 2026-09-11.
 *
 * These cases pin WHICH contention is worth waiting out. Waiting on the wrong
 * one is not neutral: a same-fire collision is a duplicate delivery that must
 * coalesce immediately, and holding it for five minutes would delay the
 * schedule that is already running.
 */

const OTHER_FIRE_KEY = 'schedule-fire#other-schedule#2026-09-12T16:00:00Z';
const OWN_FIRE_KEY = 'schedule-fire#this-schedule#2026-09-12T16:00:00Z';

function contention(ownerFireKey?: string | null): JobLockFailure {
  return {
    acquired: false,
    phase: 'lock-contention',
    severity: 'warn',
    errorMessage: 'Session lock is held',
    ...(ownerFireKey === undefined ? {} : { ownerFireKey }),
  };
}

// Only `identity` is read off the claim by resolveScheduleLockContention.
function claim(key: string) {
  return {
    identity: { key, scheduledTime: '2026-09-12T16:00:00Z' },
  } as unknown as Parameters<typeof isOwnerWorkspaceContention>[1];
}

describe('isOwnerWorkspaceContention', () => {
  it('waits when another schedule of the same owner holds the workspace', () => {
    expect(
      isOwnerWorkspaceContention(
        contention(OTHER_FIRE_KEY),
        claim(OWN_FIRE_KEY),
      ),
    ).toBe(true);
  });

  it('does NOT wait for a duplicate delivery of this same fire', () => {
    // Same fire key on both sides: this is one fire meeting its own lock, which
    // coalesces. Waiting would stall the run that is already in flight.
    expect(
      isOwnerWorkspaceContention(
        contention(OWN_FIRE_KEY),
        claim(OWN_FIRE_KEY),
      ),
    ).toBe(false);
  });

  it('does NOT wait when there is no fire claim to wait on behalf of', () => {
    // Legacy/unclaimed contention: nothing proves this fire is still wanted.
    expect(
      isOwnerWorkspaceContention(contention(OTHER_FIRE_KEY), null),
    ).toBe(false);
  });

  it('does NOT wait on a lock-config failure, which no amount of waiting fixes', () => {
    expect(
      isOwnerWorkspaceContention(
        {
          acquired: false,
          phase: 'lock-config',
          severity: 'error',
          errorMessage: 'SESSION_LOCKS_TABLE is not configured',
        },
        claim(OWN_FIRE_KEY),
      ),
    ).toBe(false);
  });

  it('does NOT wait when the holder is unidentified', () => {
    // resolveScheduleLockContention treats a missing ownerFireKey as this fire
    // meeting its own lock. Waiting it out and then proceeding would run the
    // same occurrence twice, so it must fall through to the replay marker.
    expect(
      isOwnerWorkspaceContention(contention(), claim(OWN_FIRE_KEY)),
    ).toBe(false);
    expect(
      isOwnerWorkspaceContention(contention(null), claim(OWN_FIRE_KEY)),
    ).toBe(false);
  });

  it('does NOT wait for an earlier fire of the SAME schedule (it coalesces)', () => {
    // Same schedule prefix, different scheduled time: a high-frequency schedule
    // catching its own predecessor. Coalescing must not be delayed.
    expect(
      isOwnerWorkspaceContention(
        contention('schedule-fire#this-schedule#2026-09-12T15:45:00Z'),
        claim(OWN_FIRE_KEY),
      ),
    ).toBe(false);
  });
});
