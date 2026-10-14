import { describe, expect, test } from 'bun:test';
import { agentRouterTestHelpers, createLogger } from './index';
import type { ThreadSessionRow } from './thread-session-map';

const { ownerConversationSessionId, resolveConversationSessionIdWithDependencies } =
  agentRouterTestHelpers;

// #1891. Threads stay isolated — that rule does not move. The single exception
// is a thread a SCHEDULED post created: a reply there is about that post, so it
// resolves to the run's own transcript. Every other thread keeps today's
// space+thread key, which is what these tests pin.

type Human = Parameters<typeof resolveConversationSessionIdWithDependencies>[0];
type User = Parameters<typeof resolveConversationSessionIdWithDependencies>[1];

const LOG = createLogger({ requestId: 'thread-session-map-test' });
const OWNER: User = { workspacePrefix: 'owner-a1b2c3d4' };
const SPACE = 'spaces/owner-dm';
const RUN_SESSION = 'owner-a1b2c3d4-sched-sched-morning-2026-10-13';

function human(threadName: string | undefined, spaceName = SPACE): Human {
  return { spaceName, threadName };
}

/** Shape of the unmapped key, pinned so the tests are not self-referential. */
const UNMAPPED_KEY = /^agent-chat-[0-9a-f]{64}$/;

function lookupReturning(row: ThreadSessionRow | null) {
  const keys: Array<{ spaceName: string; threadName?: string | null }> = [];
  const lookup = (async (
    _client: unknown,
    input: { spaceName: string; threadName?: string | null }
  ) => {
    keys.push(input);
    return row;
  }) as Parameters<
    typeof resolveConversationSessionIdWithDependencies
  >[3]['lookup'];
  return { lookup, keys };
}

describe('conversation session resolution for owner turns', () => {
  test('a reply in a scheduled post thread resolves to that run session', async () => {
    const reply = human(`${SPACE}/threads/brief`);
    const { lookup, keys } = lookupReturning({
      conversationSessionId: RUN_SESSION,
      workspacePrefix: OWNER.workspacePrefix,
      expiresAt: 1_900_000_000,
    });

    const resolved = await resolveConversationSessionIdWithDependencies(
      reply,
      OWNER,
      LOG,
      { tableName: 'threads', lookup }
    );

    expect(resolved).toBe(RUN_SESSION);
    expect(resolved).not.toBe(ownerConversationSessionId(reply, OWNER));
    expect(keys).toEqual([
      { tableName: 'threads', spaceName: SPACE, threadName: `${SPACE}/threads/brief` },
    ]);
  });

  test('a new top-level message gets a new, unmapped session', async () => {
    // Google gives a top-level message its own thread name, so the mapping
    // lookup misses and the key stays exactly what it is today.
    const brief = human(`${SPACE}/threads/brief`);
    const topLevel = human(`${SPACE}/threads/fresh`);
    const { lookup } = lookupReturning(null);

    const resolved = await resolveConversationSessionIdWithDependencies(
      topLevel,
      OWNER,
      LOG,
      { tableName: 'threads', lookup }
    );

    expect(resolved).toMatch(UNMAPPED_KEY);
    expect(resolved).toBe(ownerConversationSessionId(topLevel, OWNER));
    expect(resolved).not.toBe(RUN_SESSION);
    expect(resolved).not.toBe(ownerConversationSessionId(brief, OWNER));
  });

  test('two messages in one normal thread share that thread session', async () => {
    const first = human(`${SPACE}/threads/normal`);
    const laterInSameThread = human(`${SPACE}/threads/normal`);
    const otherNormalThread = human(`${SPACE}/threads/other`);
    const { lookup } = lookupReturning(null);

    const resolved = await resolveConversationSessionIdWithDependencies(
      laterInSameThread,
      OWNER,
      LOG,
      { tableName: 'threads', lookup }
    );

    expect(resolved).toMatch(UNMAPPED_KEY);
    expect(resolved).toBe(ownerConversationSessionId(first, OWNER));
    // ...and a different normal thread stays a different conversation.
    expect(resolved).not.toBe(
      ownerConversationSessionId(otherNormalThread, OWNER)
    );
  });

  test('a mapped row for another owner is ignored', async () => {
    const reply = human(`${SPACE}/threads/brief`);
    const { lookup } = lookupReturning({
      conversationSessionId: 'someone-else-sched-2026-10-13',
      workspacePrefix: 'other-owner',
      expiresAt: 1_900_000_000,
    });

    const resolved = await resolveConversationSessionIdWithDependencies(
      reply,
      OWNER,
      LOG,
      { tableName: 'threads', lookup }
    );

    expect(resolved).toBe(ownerConversationSessionId(reply, OWNER));
  });

  test('no table and no thread name skip the lookup entirely', async () => {
    const reply = human(`${SPACE}/threads/brief`);
    const unthreaded = human(undefined);
    const mapped = lookupReturning({
      conversationSessionId: RUN_SESSION,
      workspacePrefix: OWNER.workspacePrefix,
      expiresAt: 1_900_000_000,
    });

    expect(
      await resolveConversationSessionIdWithDependencies(reply, OWNER, LOG, {
        tableName: undefined,
        lookup: mapped.lookup,
      })
    ).toBe(ownerConversationSessionId(reply, OWNER));
    expect(
      await resolveConversationSessionIdWithDependencies(unthreaded, OWNER, LOG, {
        tableName: 'threads',
        lookup: mapped.lookup,
      })
    ).toBe(ownerConversationSessionId(unthreaded, OWNER));
    expect(mapped.keys).toHaveLength(0);
  });
});
