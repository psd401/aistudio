import { describe, expect, test } from 'bun:test';
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
  const messages: Array<{ level: string; message: string }> = [];
  return {
    messages,
    info: (message: string) => messages.push({ level: 'info', message }),
    warn: (message: string) => messages.push({ level: 'warn', message }),
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
