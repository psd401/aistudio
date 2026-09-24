/**
 * The durable conversation <-> workspace-object binding (#1791 finding 1).
 *
 * Before this, which Atrium object a conversation was working on lived ONLY in
 * the `?workspace=` URL param, and nothing recorded it. Three things followed,
 * all of them observed on prod:
 *
 *   - Opening the conversation again from the sidebar (`/nexus?id=<id>`) showed
 *     the chat WITHOUT the workspace panel, so the model lost its tools and the
 *     person lost the preview.
 *   - The editor's "Ask the agent" card and "Open beside chat" both went to
 *     `/nexus?workspace=<id>`, which always starts a NEW conversation. The
 *     second chat re-ran `list_available_tables`, three `inspect_table_schema`
 *     calls and several probe queries the first chat had already done, before it
 *     could make a one-table change.
 *   - There was no way to get back to the chat that already knew the artifact,
 *     because nothing connected the two.
 *
 * Every function here is scoped by `userId` in the WHERE clause, never by the
 * object's own permissions: a conversation is private to the person who had it,
 * and "who else worked on this artifact" is not a question this binding is
 * allowed to answer. The workspace id stored is always the RESOLVED object UUID
 * (the `?workspace=` param may be a slug), taken from a resolution that already
 * passed the canView gate.
 */

import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { nexusConversations } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";

/**
 * Record that this conversation worked on this object.
 *
 * Idempotent and cheap: the WHERE clause matches only when the column is still
 * NULL or already holds a DIFFERENT id, so the steady state (every turn after
 * the first) updates no rows.
 *
 * Deliberately NOT fatal. A turn that fails to record its binding is a worse
 * experience next time, not a broken turn now — so a failure is logged and
 * swallowed rather than allowed to abort a chat response the model has already
 * started producing.
 */
export async function bindConversationWorkspace(params: {
  conversationId: string;
  userId: number;
  workspaceObjectId: string;
  requestId?: string;
}): Promise<void> {
  const { conversationId, userId, workspaceObjectId, requestId } = params;
  const log = createLogger({ requestId, module: "nexus-workspace-binding" });
  try {
    await executeQuery(
      (db) =>
        db
          .update(nexusConversations)
          .set({ workspaceObjectId, updatedAt: new Date() })
          .where(
            and(
              eq(nexusConversations.id, conversationId),
              // Ownership is part of the predicate, not a prior read: there is
              // no window in which another user's row could be matched.
              eq(nexusConversations.userId, userId),
              // Unbound, or bound to a DIFFERENT object. A conversation can
              // move (open another artifact beside the same chat) and the
              // newest binding is the true one. `ne` alone would miss the NULL
              // case, since `NULL <> x` is NULL, not true — hence the `or`.
              or(
                isNull(nexusConversations.workspaceObjectId),
                ne(nexusConversations.workspaceObjectId, workspaceObjectId)
              )
            )
          ),
      "bindNexusConversationWorkspace"
    );
  } catch (error) {
    log.warn("Could not record the conversation's workspace binding", {
      conversationId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The object this conversation worked on, or null.
 *
 * Returns null for a conversation the user does not own, exactly as it does for
 * one with no binding: a caller must not be able to tell the two apart, or this
 * becomes a probe for whether a conversation id exists.
 */
export async function getConversationWorkspaceObjectId(params: {
  conversationId: string;
  userId: number;
}): Promise<string | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ workspaceObjectId: nexusConversations.workspaceObjectId })
        .from(nexusConversations)
        .where(
          and(
            eq(nexusConversations.id, params.conversationId),
            eq(nexusConversations.userId, params.userId)
          )
        )
        .limit(1),
    "getNexusConversationWorkspace"
  );
  return rows[0]?.workspaceObjectId ?? null;
}

/**
 * The user's most recently active conversation about this object, or null.
 *
 * Archived conversations are excluded: the editor's "Ask the agent" should land
 * in a live chat, and reopening something the person filed away would be a
 * surprise. Ordered by `last_message_at`, which is what "the chat I was just in"
 * means to the person clicking.
 */
export async function findLatestConversationForWorkspace(params: {
  workspaceObjectId: string;
  userId: number;
}): Promise<string | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ id: nexusConversations.id })
        .from(nexusConversations)
        .where(
          and(
            eq(nexusConversations.workspaceObjectId, params.workspaceObjectId),
            eq(nexusConversations.userId, params.userId),
            eq(nexusConversations.isArchived, false)
          )
        )
        .orderBy(desc(nexusConversations.lastMessageAt))
        .limit(1),
    "findLatestNexusConversationForWorkspace"
  );
  return rows[0]?.id ?? null;
}
