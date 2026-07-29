import { describe, expect, it, mock } from 'bun:test';
import {
  loadAuthorizedSchedule,
  type ScheduleReferenceEvent,
} from './schedule-record';

const OWNER = 'owner@psd401.net';
const SCHEDULE_ID = '36bb0456-1c51-4fb8-97d1-4e87d02765ce';

function record(overrides: Record<string, unknown> = {}) {
  return {
    userId: OWNER,
    ownerEmail: OWNER,
    scheduleId: SCHEDULE_ID,
    version: 3,
    name: 'Morning brief',
    prompt: 'Trusted row prompt',
    enabled: true,
    dmSpaceName: 'spaces/trusted-owner-dm',
    googleIdentity: 'users/12345',
    displayName: 'Owner',
    workspacePrefix: 'owner-workspace',
    ...overrides,
  };
}

async function load(
  event: ScheduleReferenceEvent,
  item: Record<string, unknown> | undefined,
) {
  const get = mock(async () => ({ Item: item }));
  const result = await loadAuthorizedSchedule(
    event,
    { get },
    'schedules',
  );
  return { result, get };
}

describe('authoritative cron schedule loading', () => {
  it('ignores forged prompt and destination fields in the trigger', async () => {
    const { result, get } = await load(
      {
        ownerEmail: OWNER,
        scheduleId: SCHEDULE_ID,
        version: 3,
        prompt: 'Forged prompt',
        dmSpaceName: 'spaces/victim',
      } as ScheduleReferenceEvent,
      record(),
    );
    expect(result).toEqual({
      authorized: true,
      schedule: record(),
    });
    const input = get.mock.calls[0][0];
    expect(input.Key).toEqual({
      userId: OWNER,
      scheduleId: SCHEDULE_ID,
    });
    expect(input.ConsistentRead).toBe(true);
  });

  it.each([
    ['missing row', undefined, 'not-found'],
    ['disabled row', record({ enabled: false }), 'disabled'],
    ['stale version', record({ version: 4 }), 'version-mismatch'],
    [
      'different stored owner',
      record({ ownerEmail: 'victim@psd401.net' }),
      'owner-mismatch',
    ],
    [
      'invalid trusted destination',
      record({ dmSpaceName: 'https://attacker.example' }),
      'invalid-record',
    ],
  ])('rejects %s before execution', async (_label, item, reason) => {
    const { result } = await load(
      { ownerEmail: OWNER, scheduleId: SCHEDULE_ID, version: 3 },
      item as Record<string, unknown> | undefined,
    );
    expect(result).toEqual({ authorized: false, reason });
  });

  it('rejects malformed references without touching DynamoDB', async () => {
    const get = mock(async () => ({ Item: record() }));
    const result = await loadAuthorizedSchedule(
      {
        ownerEmail: 'Victim@psd401.net',
        scheduleId: SCHEDULE_ID,
        version: 3,
      },
      { get },
      'schedules',
    );
    expect(result).toEqual({
      authorized: false,
      reason: 'invalid-reference',
    });
    expect(get).not.toHaveBeenCalled();
  });
});
