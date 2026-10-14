import { describe, expect, test } from 'bun:test';
import { agentCronTestHelpers } from './index';
import {
  THREAD_SESSION_TTL_SECONDS,
  lookupThreadSession,
  recordThreadSession,
  resolveThreadConversationSessionId,
  threadSessionKey,
} from './thread-session-map';

// #1891: a scheduled post (morning brief, report, digest) is sent top-level by
// cron and written into that run's own transcript. Until the thread it created
// is recorded against that transcript, a staff member replying in the thread
// lands in the generic space+thread session and the agent cannot see the post
// it is being asked about.

function silentLog() {
  const messages: Array<{
    level: string;
    message: string;
    metadata?: Record<string, unknown>;
  }> = [];
  return {
    messages,
    info: (message: string, metadata?: Record<string, unknown>) =>
      messages.push({ level: 'info', message, metadata }),
    warn: (message: string, metadata?: Record<string, unknown>) =>
      messages.push({ level: 'warn', message, metadata }),
    error: (message: string, metadata?: Record<string, unknown>) =>
      messages.push({ level: 'error', message, metadata }),
  };
}

function putRecorder() {
  const puts: Array<Record<string, unknown>> = [];
  return {
    puts,
    put: async (input: { Item?: Record<string, unknown> }) => {
      puts.push(input as Record<string, unknown>);
      return {};
    },
  };
}

describe('thread session key', () => {
  test('is space-qualified and stable', () => {
    expect(threadSessionKey('spaces/dm', 'spaces/dm/threads/one')).toBe(
      'space:spaces/dm\nthread:spaces/dm/threads/one',
    );
    expect(threadSessionKey('spaces/dm', 'spaces/dm/threads/one')).toBe(
      threadSessionKey('spaces/dm', 'spaces/dm/threads/one'),
    );
  });

  test('separates threads and spaces', () => {
    expect(threadSessionKey('spaces/dm', 'threads/one')).not.toBe(
      threadSessionKey('spaces/dm', 'threads/two'),
    );
    expect(threadSessionKey('spaces/dm', 'threads/one')).not.toBe(
      threadSessionKey('spaces/room', 'threads/one'),
    );
  });
});

describe('recordThreadSession', () => {
  test('writes the run conversation, owner and TTL against the thread', async () => {
    const client = putRecorder();
    const log = silentLog();
    const nowMs = 1_760_000_000_000;

    const written = await recordThreadSession(
      client,
      {
        tableName: 'threads',
        spaceName: 'spaces/dm',
        threadName: 'spaces/dm/threads/brief',
        conversationSessionId: 'owner-sched-abc-2026-10-13',
        workspacePrefix: 'owner-prefix',
        nowMs,
      },
      log,
    );

    expect(written).toBe(true);
    expect(client.puts).toHaveLength(1);
    const put = client.puts[0] as {
      TableName: string;
      Item: Record<string, unknown>;
    };
    expect(put.TableName).toBe('threads');
    expect(put.Item.threadKey).toBe(
      threadSessionKey('spaces/dm', 'spaces/dm/threads/brief'),
    );
    expect(put.Item.conversationSessionId).toBe('owner-sched-abc-2026-10-13');
    expect(put.Item.workspacePrefix).toBe('owner-prefix');
    expect(put.Item.expiresAt).toBe(
      Math.floor(nowMs / 1000) + THREAD_SESSION_TTL_SECONDS,
    );
  });

  test('skips (and never throws) when the thread or table is missing', async () => {
    const client = putRecorder();
    const log = silentLog();

    expect(
      await recordThreadSession(
        client,
        {
          tableName: 'threads',
          spaceName: 'spaces/dm',
          threadName: null,
          conversationSessionId: 'session',
          workspacePrefix: 'owner-prefix',
        },
        log,
      ),
    ).toBe(false);
    expect(
      await recordThreadSession(
        client,
        {
          tableName: '',
          spaceName: 'spaces/dm',
          threadName: 'spaces/dm/threads/brief',
          conversationSessionId: 'session',
          workspacePrefix: 'owner-prefix',
        },
        log,
      ),
    ).toBe(false);
    expect(client.puts).toHaveLength(0);
  });

  test('swallows a write failure so delivery is never re-queued', async () => {
    const log = silentLog();
    const written = await recordThreadSession(
      {
        put: async () => {
          throw new Error('throttled');
        },
      },
      {
        tableName: 'threads',
        spaceName: 'spaces/dm',
        threadName: 'spaces/dm/threads/brief',
        conversationSessionId: 'session',
        workspacePrefix: 'owner-prefix',
      },
      log,
    );

    expect(written).toBe(false);
    expect(log.messages.map((m) => m.message)).toContain(
      'thread_session_map_write_failed',
    );
  });
});

describe('lookupThreadSession', () => {
  test('returns the mapped row for the recorded thread', async () => {
    const log = silentLog();
    const row = await lookupThreadSession(
      {
        get: async (input: { Key?: Record<string, unknown> }) => {
          expect(input.Key?.threadKey).toBe(
            threadSessionKey('spaces/dm', 'spaces/dm/threads/brief'),
          );
          return {
            Item: {
              conversationSessionId: 'owner-sched-abc-2026-10-13',
              workspacePrefix: 'owner-prefix',
            },
          };
        },
      },
      {
        tableName: 'threads',
        spaceName: 'spaces/dm',
        threadName: 'spaces/dm/threads/brief',
      },
      log,
    );

    expect(row).toEqual({
      conversationSessionId: 'owner-sched-abc-2026-10-13',
      workspacePrefix: 'owner-prefix',
    });
  });

  test('is null for an unmapped thread, a malformed row, and a read failure', async () => {
    const log = silentLog();
    const base = {
      tableName: 'threads',
      spaceName: 'spaces/dm',
      threadName: 'spaces/dm/threads/normal',
    };

    expect(
      await lookupThreadSession({ get: async () => ({}) }, base, log),
    ).toBeNull();
    expect(
      await lookupThreadSession(
        { get: async () => ({ Item: { workspacePrefix: 'owner-prefix' } }) },
        base,
        log,
      ),
    ).toBeNull();
    expect(
      await lookupThreadSession(
        {
          get: async () => {
            throw new Error('timeout');
          },
        },
        base,
        log,
      ),
    ).toBeNull();
  });
});

describe('resolveThreadConversationSessionId', () => {
  test('follows a mapped row for the same owner', () => {
    expect(
      resolveThreadConversationSessionId(
        {
          mapped: {
            conversationSessionId: 'owner-sched-abc-2026-10-13',
            workspacePrefix: 'owner-prefix',
          },
          workspacePrefix: 'owner-prefix',
          fallbackConversationSessionId: 'agent-chat-hash',
        },
        silentLog(),
      ),
    ).toBe('owner-sched-abc-2026-10-13');
  });

  test('never crosses owners', () => {
    const log = silentLog();
    expect(
      resolveThreadConversationSessionId(
        {
          mapped: {
            conversationSessionId: 'someone-else-sched',
            workspacePrefix: 'other-prefix',
          },
          workspacePrefix: 'owner-prefix',
          fallbackConversationSessionId: 'agent-chat-hash',
        },
        log,
      ),
    ).toBe('agent-chat-hash');
    expect(log.messages.map((m) => m.message)).toContain(
      'thread_session_map_owner_mismatch',
    );
    // The mismatch line must not carry either side's workspace prefix: it
    // embeds an email local part, and this is the one case with two owners.
    expect(JSON.stringify(log.messages)).not.toContain('other-prefix');
    expect(JSON.stringify(log.messages)).not.toContain('owner-prefix');
  });

  test('falls back when there is no row', () => {
    expect(
      resolveThreadConversationSessionId(
        {
          mapped: null,
          workspacePrefix: 'owner-prefix',
          fallbackConversationSessionId: 'agent-chat-hash',
        },
        silentLog(),
      ),
    ).toBe('agent-chat-hash');
  });
});

// The wiring, not just the helper: a refactor that drops `deliveredThreadName`
// or passes the wrong identity through would pass every test above.
describe('deliverScheduledResult writes the mapping for the delivered post', () => {
  const { deliverScheduledResultWithDependencies, toInvokeResult } =
    agentCronTestHelpers;

  function context(log: ReturnType<typeof silentLog>) {
    return {
      schedule: {
        scheduleId: 'sched-morning',
        ownerEmail: 'owner@psd401.net',
        dmSpaceName: 'spaces/owner-dm',
        workspacePrefix: 'owner-a1b2c3d4',
      },
      scheduleName: 'Morning brief',
      startTime: Date.now(),
      sessionId: 'owner-a1b2c3d4-sched-sched-morning-2026-10-13',
      runtimeSessionId: 'agent-rt-x',
      workspaceLockId: 'agent-workspace-x',
      fireIdentity: null,
      result: toInvokeResult({ result: 'Here is your brief.', metadata: {} }),
      log,
    } as never;
  }

  test('records the created thread against the run conversation', async () => {
    const log = silentLog();
    const recorded: Array<Record<string, unknown>> = [];

    const outcome = await deliverScheduledResultWithDependencies(
      context(log),
      {
        sendPreparedChatMessage: (async () =>
          'spaces/owner-dm/threads/brief') as never,
        recordThreadSession: (async (
          _client: unknown,
          input: Record<string, unknown>,
        ) => {
          recorded.push(input);
          return true;
        }) as never,
      },
    );

    expect(outcome).toEqual({ status: 'success', scheduleId: 'sched-morning' });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      spaceName: 'spaces/owner-dm',
      threadName: 'spaces/owner-dm/threads/brief',
      conversationSessionId: 'owner-a1b2c3d4-sched-sched-morning-2026-10-13',
      workspacePrefix: 'owner-a1b2c3d4',
    });
  });

  test('records nothing when Chat returns no thread', async () => {
    const log = silentLog();
    const recorded: unknown[] = [];

    await deliverScheduledResultWithDependencies(context(log), {
      sendPreparedChatMessage: (async () => null) as never,
      recordThreadSession: (async (_c: unknown, input: unknown) => {
        recorded.push(input);
        return true;
      }) as never,
    });

    expect(recorded).toHaveLength(0);
  });

  test('a delivery failure routed to the outbox records nothing', async () => {
    const log = silentLog();
    const recorded: unknown[] = [];

    await deliverScheduledResultWithDependencies(context(log), {
      sendPreparedChatMessage: (async () => {
        throw new Error('Chat unavailable');
      }) as never,
      recordThreadSession: (async (_c: unknown, input: unknown) => {
        recorded.push(input);
        return true;
      }) as never,
    });

    // No thread name exists for an outbox delivery, so the reply keeps the
    // pre-#1891 key rather than being mapped to a post that never landed.
    expect(recorded).toHaveLength(0);
  });
});
