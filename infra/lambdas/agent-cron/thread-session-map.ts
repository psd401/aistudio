/**
 * Thread → conversation-session mapping for scheduled Chat posts (#1891).
 *
 * The cron and router Lambdas bundle independently, so this module exists as
 * two byte-identical copies below this header; the lockstep test in
 * agent-cron asserts they never drift. The key derivation MUST match on both
 * sides or a reply lands back in the generic `space + thread` session.
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
  /** Epoch seconds. The reader enforces it; DynamoDB TTL only sweeps. */
  expiresAt: number;
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
        // Operator field: the table has no other way to tell a row written by
        // today's run from one the TTL has not swept yet. Nothing reads it.
        createdAt: new Date(nowMs).toISOString(),
        expiresAt:
          Math.floor(nowMs / 1000) + THREAD_SESSION_TTL_SECONDS,
      },
    });
    // The owner's own conversation id is logged here, as cron already logs it
    // on every scheduled run ('Scheduled task started'). Only the cross-owner
    // path below withholds identifiers.
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
 * A row is only usable with all three fields intact. A partial row is a bug or
 * a half-written item, never something to route a conversation on.
 */
function parseThreadSessionRow(
  item: Record<string, unknown> | undefined,
): ThreadSessionRow | null {
  if (!item) return null;
  const { conversationSessionId, workspacePrefix, expiresAt } = item;
  if (typeof conversationSessionId !== 'string' || !conversationSessionId) {
    return null;
  }
  if (typeof workspacePrefix !== 'string' || !workspacePrefix) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return { conversationSessionId, workspacePrefix, expiresAt };
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
    nowMs?: number;
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
    const row = parseThreadSessionRow(result?.Item);
    if (!row) {
      if (result?.Item) {
        log.warn('thread_session_map_row_malformed', {
          space: input.spaceName,
          thread: input.threadName,
        });
      }
      return null;
    }
    // TTL deletion is asynchronous — DynamoDB keeps serving an expired item to
    // reads for up to ~48 hours after its timestamp passes. Enforce the window
    // here so the advertised 14 days is the real one, not a floor.
    const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
    if (row.expiresAt <= nowSeconds) {
      log.info('thread_session_map_row_expired', {
        space: input.spaceName,
        thread: input.threadName,
      });
      return null;
    }
    return row;
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
    // Value-free on purpose. `workspacePrefix` embeds the owner's email local
    // part and the conversation id embeds the prefix, and this line fires
    // precisely when a row belongs to a DIFFERENT owner — the one case where
    // logging either side would put two people's identifiers in one record.
    // The caller's own lines carry the space and thread, which is what an
    // operator needs to find the row.
    log.warn('thread_session_map_owner_mismatch', {});
    return fallbackConversationSessionId;
  }
  return mapped.conversationSessionId;
}
