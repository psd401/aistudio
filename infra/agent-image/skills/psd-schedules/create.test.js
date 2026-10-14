'use strict';

/**
 * psd-schedules create.js refusal reporting (#1889).
 *
 * SKILL.md's 409 table tells the agent to branch on `code` and to act on
 * `existingScheduleId`. Those fields live on the broker's JSON body, which
 * `requestAgentBroker` hangs off `error.responseBody` — but the catch handler
 * printed only `error.message`, so the field the agent was told to read never
 * reached its transcript. These tests pin the extraction.
 */

const { describe, expect, it } = require('bun:test');
const { refusalDetail } = require('./create');

function brokerError(status, responseBody) {
  return Object.assign(new Error(`Agent broker rejected (HTTP ${status})`), {
    status,
    responseBody,
  });
}

describe('psd-schedules create refusal detail', () => {
  it('extracts the name-conflict code and existing id', () => {
    expect(
      refusalDetail(
        brokerError(409, {
          error: 'A schedule named "Morning brief" already exists',
          code: 'name_conflict',
          existingScheduleId: 'schedule-1',
        })
      )
    ).toEqual({ code: 'name_conflict', existingScheduleId: 'schedule-1' });
  });

  it('extracts the duplicate code with the existing name', () => {
    expect(
      refusalDetail(
        brokerError(409, {
          error: 'An enabled schedule with the same cadence and prompt exists',
          code: 'possible_duplicate',
          existingScheduleId: 'schedule-1',
          existingScheduleName: 'Morning brief',
        })
      )
    ).toEqual({
      code: 'possible_duplicate',
      existingScheduleId: 'schedule-1',
      existingScheduleName: 'Morning brief',
    });
  });

  it('omits a null existing id rather than emitting it', () => {
    // The guard row can exist with no readable target. The prose message still
    // names the schedule; the agent must not be handed `null` as an id to
    // update.
    expect(
      refusalDetail(
        brokerError(409, {
          code: 'name_conflict',
          existingScheduleId: null,
        })
      )
    ).toEqual({ code: 'name_conflict' });
  });

  it('echoes only the three documented fields, never the whole body', () => {
    // requestAgentBroker deliberately never echoes a parsed body wholesale,
    // because other brokers answer with secret fields alongside the status.
    const detail = refusalDetail(
      brokerError(409, {
        code: 'name_conflict',
        existingScheduleId: 'schedule-1',
        accessToken: 'super-secret',
      })
    );
    expect(detail).toEqual({
      code: 'name_conflict',
      existingScheduleId: 'schedule-1',
    });
    expect(Object.keys(detail)).not.toContain('accessToken');
  });

  it('returns null for a 409 that carries no recognized code', () => {
    // The integrity refusals are 409 but are not duplicates; SKILL.md tells
    // the agent to stop rather than rename or force the create.
    expect(
      refusalDetail(
        brokerError(409, { error: 'Legacy schedules contain duplicate names' })
      )
    ).toBeNull();
  });

  it('returns null for non-409 failures and malformed errors', () => {
    expect(refusalDetail(brokerError(429, { code: 'name_conflict' }))).toBeNull();
    expect(refusalDetail(brokerError(409, 'not an object'))).toBeNull();
    expect(refusalDetail(brokerError(409, null))).toBeNull();
    expect(refusalDetail(new Error('network down'))).toBeNull();
    expect(refusalDetail(null)).toBeNull();
    expect(refusalDetail(undefined)).toBeNull();
  });
});
