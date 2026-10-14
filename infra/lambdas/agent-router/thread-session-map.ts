/**
 * Thread -> conversation-session mapping for scheduled Chat posts (#1891).
 *
 * Duplicated from agent-cron/thread-session-map.ts because the two Lambdas
 * bundle independently. Everything below this header is byte-identical and the
 * lockstep test in agent-cron proves it; only the cron writes rows, only the
 * router reads them, and both must derive the same key.
 */
import type { GetCommandInput, PutCommandInput } from '@aws-sdk/lib-dynamodb';

/**
 * Scheduled posts stay repliable for two weeks. Long enough that a brief read
 * on Monday can still be answered the following week, short enough that the
 * table never becomes a durable record of who said what.
 */
export const THREAD_SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

export interface ThreadSessionRow {
  /** OpenClaw conversation transcript the scheduled post was written in. */
  conversationSessionId: string;
  /** Owner the mapped session belongs to; the reader must re-check it. */
  workspacePrefix: string;
}

/** Only the cron writes rows. */
export interface ThreadSessionWriter {
  put(input: PutCommandInput): Promise<unknown>;
}

/** Only the router reads them. */
export interface ThreadSessionReader {
  get(input: GetCommandInput): Promise<{ Item?: Record<string, unknown> }>;
}

interface ThreadSessionLogger {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
}

/**
 * Partition key. Google thread names are already space-qualified
 * (`spaces/X/threads/Y`), but the space is kept explicit so a malformed or
 * legacy thread name can never collide across spaces.
 */
export function threadSessionKey(
  spaceName: string,
  threadName: string,
): string {
  return `space:${spaceName}\nthread:${threadName}`;
}

/**
 * Best-effort: a scheduled post is already delivered by the time this runs, so
 * a mapping failure must never fail the delivery. Without the row the router
 * simply keeps today's `space + thread` key.
 */
export async function recordThreadSession(
  client: ThreadSessionWriter,
  input: {
    tableName: string;
    spaceName: string;
    threadName: string | null | undefined;
    conversationSessionId: string;
    workspacePrefix: string;
    nowMs?: number;
  },
  log: ThreadSessionLogger,
): Promise<boolean> {
  if (!input.tableName || !input.threadName || !input.spaceName) {
    log.warn('thread_session_map_skipped', {
      hasTable: Boolean(input.tableName),
      hasSpace: Boolean(input.spaceName),
      hasThread: Boolean(input.threadName),
    });
    return false;
  }
  const nowMs = input.nowMs ?? Date.now();
  try {
    await client.put({
      TableName: input.tableName,
      Item: {
        threadKey: threadSessionKey(input.spaceName, input.threadName),
        conversationSessionId: input.conversationSessionId,
        workspacePrefix: input.workspacePrefix,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt:
          Math.floor(nowMs / 1000) + THREAD_SESSION_TTL_SECONDS,
      },
    });
    log.info('thread_session_map_recorded', {
      space: input.spaceName,
      thread: input.threadName,
      conversationSessionId: input.conversationSessionId,
    });
    return true;
  } catch (error) {
    log.warn('thread_session_map_write_failed', {
      space: input.spaceName,
      thread: input.threadName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Returns the mapped row, or null when this thread did not start with a
 * scheduled post. Lookup errors resolve to null so the caller falls back to
 * the unmapped key rather than dropping the turn.
 */
export async function lookupThreadSession(
  client: ThreadSessionReader,
  input: {
    tableName: string;
    spaceName: string;
    threadName: string | null | undefined;
  },
  log: ThreadSessionLogger,
): Promise<ThreadSessionRow | null> {
  if (!input.tableName || !input.threadName || !input.spaceName) return null;
  try {
    const result = await client.get({
      TableName: input.tableName,
      Key: {
        threadKey: threadSessionKey(input.spaceName, input.threadName),
      },
    });
    const item = result?.Item;
    if (!item) return null;
    const conversationSessionId = item.conversationSessionId;
    const workspacePrefix = item.workspacePrefix;
    if (
      typeof conversationSessionId !== 'string' ||
      !conversationSessionId ||
      typeof workspacePrefix !== 'string' ||
      !workspacePrefix
    ) {
      log.warn('thread_session_map_row_malformed', {
        space: input.spaceName,
        thread: input.threadName,
      });
      return null;
    }
    return { conversationSessionId, workspacePrefix };
  } catch (error) {
    log.warn('thread_session_map_read_failed', {
      space: input.spaceName,
      thread: input.threadName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The owner check is the whole safety property: a mapping row only ever
 * redirects a turn into a transcript belonging to the SAME owner. A row for
 * another workspace is ignored, not followed.
 */
export function resolveThreadConversationSessionId(
  input: {
    mapped: ThreadSessionRow | null;
    workspacePrefix: string;
    fallbackConversationSessionId: string;
  },
  log: ThreadSessionLogger,
): string {
  const { mapped, workspacePrefix, fallbackConversationSessionId } = input;
  if (!mapped) return fallbackConversationSessionId;
  if (mapped.workspacePrefix !== workspacePrefix) {
    log.warn('thread_session_map_owner_mismatch', {
      mappedWorkspacePrefix: mapped.workspacePrefix,
      workspacePrefix,
    });
    return fallbackConversationSessionId;
  }
  return mapped.conversationSessionId;
}
