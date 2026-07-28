/**
 * Unit tests for async-job promotion logic (issue #1138).
 *
 * Run: bun test job-promotion.test.ts (from this directory).
 */

import { describe, expect, test } from 'bun:test';

import {
  buildContinuationPrompt,
  buildJobPayload,
  formatJobChatResponse,
  JOB_DEADLINE_S,
  parseJobPayload,
  shouldPromoteToJob,
} from './job-promotion';

describe('shouldPromoteToJob', () => {
  test('deadline classes promote', () => {
    expect(shouldPromoteToJob('ChatDeadlineExpired')).toBe(true);
    expect(shouldPromoteToJob('ChatDeadlineExpiredPartial')).toBe(true);
  });

  test('real errors and clean turns do NOT promote', () => {
    expect(shouldPromoteToJob('OpenClawChatError')).toBe(false);
    expect(shouldPromoteToJob('EmptyAgentResponse')).toBe(false);
    expect(shouldPromoteToJob('AgentCoreHttpError_500')).toBe(false);
    expect(shouldPromoteToJob(undefined)).toBe(false);
    expect(shouldPromoteToJob('')).toBe(false);
  });
});

const BASE = {
  sessionId: 'user-abc123-deadbeef-tag',
  lockToken: 'tok-1',
  runtimeId: 'psd_agent_dev-XYZ',
  userEmail: 'hagelk@psd401.net',
  displayName: 'Kris Hagel',
  workspacePrefix: 'hagelk-abc123',
  spaceName: 'spaces/AAA',
  isDM: true,
  originalPrompt: 'do the big task',
};

describe('buildJobPayload / parseJobPayload round-trip', () => {
  test('round-trips all fields', () => {
    const parsed = parseJobPayload(buildJobPayload({ ...BASE, threadName: 'spaces/AAA/threads/t1' }));
    expect(parsed.sessionId).toBe(BASE.sessionId);
    expect(parsed.lockToken).toBe(BASE.lockToken);
    expect(parsed.runtimeId).toBe(BASE.runtimeId);
    expect(parsed.userEmail).toBe(BASE.userEmail);
    expect(parsed.workspacePrefix).toBe(BASE.workspacePrefix);
    expect(parsed.spaceName).toBe(BASE.spaceName);
    expect(parsed.threadName).toBe('spaces/AAA/threads/t1');
    expect(parsed.isDM).toBe(true);
    expect(parsed.promptExcerpt).toBe('do the big task');
  });

  test('omits threadName when absent (top-level message)', () => {
    const parsed = parseJobPayload(buildJobPayload(BASE));
    expect(parsed.threadName).toBeUndefined();
  });

  test('round-trips an aside response marker for the background reply', () => {
    const parsed = parseJobPayload(
      buildJobPayload({ ...BASE, responsePrefix: '[aside] ' })
    );
    expect(parsed.responsePrefix).toBe('[aside] ');
  });

  test('round-trips optional scheduled-run context', () => {
    const longestValidScheduleName = 'n'.repeat(120);
    const parsed = parseJobPayload(
      buildJobPayload({
        ...BASE,
        scheduleId: '36bb0456-1c51-4fb8-97d1-4e87d02765ce',
        scheduleName: longestValidScheduleName,
      })
    );
    expect(parsed.scheduleId).toBe(
      '36bb0456-1c51-4fb8-97d1-4e87d02765ce'
    );
    expect(parsed.scheduleName).toBe(longestValidScheduleName);
  });

  test('prompt excerpt truncates to keep the payload under the RunTask 8KiB cap', () => {
    const parsed = parseJobPayload(
      buildJobPayload({ ...BASE, originalPrompt: 'x'.repeat(10_000) })
    );
    expect(parsed.promptExcerpt.length).toBe(2000);
    expect(buildJobPayload({ ...BASE, originalPrompt: 'x'.repeat(10_000) }).length).toBeLessThan(4096);
  });

  test('parse rejects empty, invalid JSON, and missing fields', () => {
    expect(() => parseJobPayload(undefined)).toThrow('empty');
    expect(() => parseJobPayload('not json')).toThrow('not valid JSON');
    const missing = JSON.stringify({ sessionId: 's' });
    expect(() => parseJobPayload(missing)).toThrow('lockToken');
  });
});

describe('buildContinuationPrompt', () => {
  test('includes the job-continuation marker, side-effect caution, and excerpt', () => {
    const prompt = buildContinuationPrompt('summarize the 7/1 meeting');
    expect(prompt).toContain('[job-continuation]');
    expect(prompt).toContain('re-running');
    expect(prompt).toContain('summarize the 7/1 meeting');
  });

  test('no excerpt → no dangling excerpt block', () => {
    expect(buildContinuationPrompt('')).not.toContain('original request excerpt');
  });
});

describe('formatJobChatResponse', () => {
  test('uses the persisted aside marker on the final background reply', () => {
    expect(
      formatJobChatResponse(
        {
          isDM: true,
          displayName: BASE.displayName,
          responsePrefix: '[aside] ',
        },
        'background result'
      )
    ).toBe('[aside] background result');
  });

  test('retains the existing DM and shared-space defaults', () => {
    expect(
      formatJobChatResponse(
        { isDM: true, displayName: BASE.displayName },
        'DM result'
      )
    ).toBe('DM result');
    expect(
      formatJobChatResponse(
        { isDM: false, displayName: BASE.displayName },
        'room result'
      )
    ).toBe(`[${BASE.displayName}'s Agent] room result`);
  });
});

describe('JOB_DEADLINE_S', () => {
  test('matches the approved 2-hour ceiling (harness clamp mirror)', () => {
    expect(JOB_DEADLINE_S).toBe(7200);
  });
});
