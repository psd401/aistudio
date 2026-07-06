"use server"

/**
 * Atrium document comment server actions (Epic #1059, §18.1)
 *
 * The human surface over `atrium_doc_comments` (migration 098): list a document's
 * comment threads, open a new thread, reply to one, and resolve/reopen it. Thread
 * BODIES live in Postgres; the ANCHOR (which span the thread hangs off) lives in
 * the Y.Doc as a comment mark carrying the same `threadId` (see
 * lib/content/collab/comment-mark.ts). These actions never touch the Y.Doc — the
 * editor mints the `threadId`, marks the span, and calls
 * `createCommentThreadAction` with that id; the two are joined by `threadId`.
 *
 * Authorization ladder (mirrors snapshot-document.ts, §12.4):
 *  - resolve the requester FIRST → an unauthenticated caller gets a 401
 *    (authNoSession), never a 403.
 *  - existence 404 (loadByIdOrSlug) then `canView` 404-mask → a non-viewable
 *    object 404s rather than revealing via a 403 that this UUID exists.
 *  - WRITES additionally require the `atrium-content` feature capability (403) and
 *    per-object edit permission (`assertCanEdit`, 403). READS stop at `canView`:
 *    anyone who can view the document can read the comments on it.
 *
 * `resolved` is thread-level state, written to EVERY row of the thread (root +
 * replies) so the column stays consistent regardless of which row a reader
 * inspects; the canonical value is the root's, and the reader counts open threads
 * off the roots.
 *
 * See docs/features/atrium-design-spec.md §18.1.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  createLogger,
  generateRequestId,
  sanitizeForLogging,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { executeQuery } from "@/lib/db/drizzle-client";
import { atriumDocComments, users } from "@/lib/db/schema";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { assertCanEdit, authorUserIdOf } from "@/lib/content/helpers";
import { NotFoundError } from "@/lib/content/errors";
import type { ContentObjectDTO, Requester } from "@/lib/content/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import type { ActionState } from "@/types";
import { getUserRequester } from "./requester";

/** A single comment (root or reply) as the reader panel renders it. */
export interface CommentDTO {
  id: string;
  body: string;
  authorLabel: string;
  authorKind: "human" | "agent";
  createdAt: string | null;
}

/** A comment thread: its client-minted id, resolved state, and comments in order. */
export interface CommentThreadDTO {
  threadId: string;
  resolved: boolean;
  comments: CommentDTO[];
}

/** Max comment body length (chars) — a review comment, not a document. */
const BODY_MAX_LENGTH = 5000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The comment columns (plus the joined human name/email) every read query
 * selects, so the row → DTO mapping has one shape.
 */
const commentSelect = {
  id: atriumDocComments.id,
  threadId: atriumDocComments.threadId,
  parentId: atriumDocComments.parentId,
  body: atriumDocComments.body,
  authorUserId: atriumDocComments.authorUserId,
  authorAgentId: atriumDocComments.authorAgentId,
  authorLabel: atriumDocComments.authorLabel,
  resolved: atriumDocComments.resolved,
  createdAt: atriumDocComments.createdAt,
  userFirstName: users.firstName,
  userLastName: users.lastName,
  userEmail: users.email,
} as const;

/** The row shape produced by `commentSelect` (comment left-joined to its author). */
interface CommentRow {
  id: string;
  threadId: string;
  parentId: string | null;
  body: string;
  authorUserId: number | null;
  authorAgentId: string | null;
  authorLabel: string | null;
  resolved: boolean;
  createdAt: Date | null;
  userFirstName: string | null;
  userLastName: string | null;
  userEmail: string | null;
}

/**
 * Map one comment row to a DTO. `authorKind` keys off the absence of a HUMAN author
 * (`authorUserId == null`), NOT on `authorAgentId`: the agent bridge may use a
 * documented non-UUID `X-Agent-Id` (e.g. "bot-1"), which is recorded as an
 * `authorLabel` with a null `authorAgentId` — classifying on `authorAgentId` alone
 * would mislabel those agent comments as human. UI comments always carry an
 * `authorUserId`; bridge comments never do. `authorLabel` falls back to the joined
 * human name/email so the reader never renders an empty author.
 */
function toCommentDTO(row: CommentRow): CommentDTO {
  const isAgent = row.authorUserId == null;
  const humanName = [row.userFirstName, row.userLastName]
    .filter((part) => Boolean(part && part.trim()))
    .join(" ")
    .trim();
  const fallback = isAgent ? "Agent" : humanName || row.userEmail || "Unknown";
  return {
    id: row.id,
    body: row.body,
    authorKind: isAgent ? "agent" : "human",
    authorLabel: row.authorLabel ?? fallback,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
  };
}

/**
 * Group ordered rows into threads. Rows arrive sorted so each thread's root
 * (parent_id NULL) is first, then replies by created_at; thread order is
 * first-seen. The thread's `resolved` is taken from the root (canonical), though
 * every row mirrors it.
 */
function groupThreads(rows: CommentRow[]): CommentThreadDTO[] {
  const threads: CommentThreadDTO[] = [];
  const byThreadId = new Map<string, CommentThreadDTO>();
  for (const row of rows) {
    let thread = byThreadId.get(row.threadId);
    if (!thread) {
      thread = { threadId: row.threadId, resolved: row.resolved, comments: [] };
      byThreadId.set(row.threadId, thread);
      threads.push(thread);
    }
    // The root sorts first; its resolved is the canonical thread state.
    if (row.parentId == null) thread.resolved = row.resolved;
    thread.comments.push(toCommentDTO(row));
  }
  return threads;
}

/**
 * Resolve the requester and the target object, enforcing the shared gate ladder:
 * requester (401) → optional feature capability (403) → existence (404) → canView
 * (404-mask) → optional edit permission (403). Returns the requester + object for
 * the caller to act on.
 */
async function resolveGatedObject(
  requestId: string,
  idOrSlug: string,
  opts: { requireCapability: boolean; requireEdit: boolean }
): Promise<{ requester: Requester; obj: ContentObjectDTO }> {
  // Resolve the session ONCE and thread it through both the requester build and
  // the capability check (same-session invariant, matching snapshot-document.ts).
  const session = await getServerSession();
  const requester = await getUserRequester(requestId, session);
  if (opts.requireCapability) {
    if (!(await hasCapabilityAccess("atrium-content", session!.sub))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }
  }

  const obj = await contentService.loadByIdOrSlug(idOrSlug);
  if (!obj) throw new NotFoundError("Content object not found", { idOrSlug });

  const viewable = await visibilityService.canView(requester, {
    id: obj.id,
    ownerUserId: obj.ownerUserId,
    visibilityLevel: obj.visibilityLevel,
  });
  // Mask existence: a non-viewable object 404s (never a 403) — the edit gate below
  // only applies once the caller can already see the object.
  if (!viewable) throw new NotFoundError("Content object not found", { idOrSlug });

  if (opts.requireEdit) {
    assertCanEdit(requester, obj.ownerUserId);
  }
  return { requester, obj };
}

/** Validate + normalize a comment body, throwing a typed 400 on empty/too-long. */
function normalizeBody(body: unknown): string {
  if (typeof body !== "string" || !body.trim()) {
    throw ErrorFactories.missingRequiredField("body");
  }
  const trimmed = body.trim();
  if (trimmed.length > BODY_MAX_LENGTH) {
    throw ErrorFactories.invalidInput(
      "body",
      trimmed.length,
      `body must be ${BODY_MAX_LENGTH} characters or fewer`
    );
  }
  return trimmed;
}

/** Validate the client-minted threadId (a uuid), throwing a typed 400 otherwise. */
function normalizeThreadId(threadId: unknown): string {
  if (typeof threadId !== "string" || !UUID_RE.test(threadId.trim())) {
    throw ErrorFactories.invalidInput(
      "threadId",
      typeof threadId === "string" ? threadId : null,
      "threadId must be a uuid"
    );
  }
  return threadId.trim();
}

/** Load one thread's rows (root + replies) and map to a DTO; 404 if it is empty. */
async function loadThreadDTO(
  objectId: string,
  threadId: string
): Promise<CommentThreadDTO> {
  const rows = (await executeQuery(
    (db) =>
      db
        .select(commentSelect)
        .from(atriumDocComments)
        .leftJoin(users, eq(atriumDocComments.authorUserId, users.id))
        .where(
          and(
            eq(atriumDocComments.objectId, objectId),
            eq(atriumDocComments.threadId, threadId)
          )
        )
        // Root (parent_id NULL) first, then replies by created_at; id breaks ties.
        .orderBy(
          sql`${atriumDocComments.parentId} IS NOT NULL`,
          atriumDocComments.createdAt,
          atriumDocComments.id
        ),
    "atrium.comments.loadThread"
  )) as CommentRow[];

  const thread = groupThreads(rows)[0];
  if (!thread) {
    throw new NotFoundError("Comment thread not found", { threadId });
  }
  return thread;
}

/**
 * List all comment threads on a document (read-gated by `canView`). Threads are
 * grouped by `thread_id` (root first, then replies by created_at), each carrying
 * its resolved state. A viewer who cannot edit still sees every thread they can
 * view — comments are a read affordance, not an authoring-only one.
 */
export async function listCommentThreadsAction(
  idOrSlug: string
): Promise<ActionState<CommentThreadDTO[]>> {
  const requestId = generateRequestId();
  const timer = startTimer("listCommentThreadsAction");
  const log = createLogger({ requestId, action: "listCommentThreadsAction" });

  try {
    log.info("Action started: list comment threads", {
      idOrSlug: sanitizeForLogging(idOrSlug),
    });

    // Reads are NOT feature-capability gated (parity with getContentAction): read
    // access is bounded entirely by canView. No edit gate — any viewer may read.
    const { obj } = await resolveGatedObject(requestId, idOrSlug, {
      requireCapability: false,
      requireEdit: false,
    });

    const rows = (await executeQuery(
      (db) =>
        db
          .select(commentSelect)
          .from(atriumDocComments)
          .leftJoin(users, eq(atriumDocComments.authorUserId, users.id))
          .where(eq(atriumDocComments.objectId, obj.id))
          // Group by thread, root first, then replies by created_at (id tiebreak).
          .orderBy(
            atriumDocComments.threadId,
            sql`${atriumDocComments.parentId} IS NOT NULL`,
            atriumDocComments.createdAt,
            atriumDocComments.id
          ),
      "atrium.comments.listThreads"
    )) as CommentRow[];

    const data = groupThreads(rows);
    timer({ status: "success" });
    log.info("Comment threads loaded", {
      objectId: obj.id,
      threadCount: data.length,
    });
    return createSuccess(data, "Comments loaded");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load comments", {
      context: "listCommentThreadsAction",
      requestId,
      operation: "listCommentThreadsAction",
    });
  }
}

/**
 * Count OPEN (unresolved) comment threads on a document — the reader's editors-only
 * comment chip. A cheap `COUNT` over the root rows (backed by `idx_adc_object_resolved`),
 * NOT `listCommentThreadsAction`, which would load + serialize every comment BODY just
 * to compute a number on the hot RSC reader render path. canView-gated (same as list).
 */
export async function countUnresolvedCommentThreadsAction(
  idOrSlug: string
): Promise<ActionState<number>> {
  const requestId = generateRequestId();
  const timer = startTimer("countUnresolvedCommentThreadsAction");

  try {
    const { obj } = await resolveGatedObject(requestId, idOrSlug, {
      requireCapability: false,
      requireEdit: false,
    });

    const rows = (await executeQuery(
      (db) =>
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(atriumDocComments)
          .where(
            and(
              eq(atriumDocComments.objectId, obj.id),
              isNull(atriumDocComments.parentId),
              eq(atriumDocComments.resolved, false)
            )
          ),
      "atrium.comments.countUnresolved"
    )) as Array<{ n: number }>;

    timer({ status: "success" });
    return createSuccess(rows[0]?.n ?? 0, "Counted");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to count comments", {
      context: "countUnresolvedCommentThreadsAction",
      requestId,
      operation: "countUnresolvedCommentThreadsAction",
    });
  }
}

/**
 * Open a new comment thread on a document (edit-gated). Inserts the thread root
 * (`parent_id` NULL) with the client-minted `threadId` that also marks the anchor
 * span in the editor. Returns the new thread DTO.
 */
export async function createCommentThreadAction(
  idOrSlug: string,
  input: { threadId: string; body: string }
): Promise<ActionState<CommentThreadDTO>> {
  const requestId = generateRequestId();
  const timer = startTimer("createCommentThreadAction");
  const log = createLogger({ requestId, action: "createCommentThreadAction" });

  try {
    log.info("Action started: create comment thread", {
      idOrSlug: sanitizeForLogging(idOrSlug),
    });

    const { requester, obj } = await resolveGatedObject(requestId, idOrSlug, {
      requireCapability: true,
      requireEdit: true,
    });
    const threadId = normalizeThreadId(input?.threadId);
    const body = normalizeBody(input?.body);

    // Idempotent on the caller-supplied threadId: the uq_adc_thread_root partial
    // unique index guarantees one root per (object, thread), so a retried create
    // (same threadId) is a no-op that returns the existing thread rather than a 500.
    await executeQuery(
      (db) =>
        db
          .insert(atriumDocComments)
          .values({
            objectId: obj.id,
            threadId,
            parentId: null,
            body,
            authorUserId: authorUserIdOf(requester),
          })
          .onConflictDoNothing({
            target: [atriumDocComments.objectId, atriumDocComments.threadId],
            where: isNull(atriumDocComments.parentId),
          }),
      "atrium.comments.insertRoot"
    );

    const thread = await loadThreadDTO(obj.id, threadId);
    timer({ status: "success" });
    log.info("Comment thread created", { objectId: obj.id, threadId });
    return createSuccess(thread, "Comment added");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to add comment", {
      context: "createCommentThreadAction",
      requestId,
      operation: "createCommentThreadAction",
    });
  }
}

/**
 * Reply to an existing thread (edit-gated). Resolves the thread's root by
 * `threadId` (404 if there is no thread for this object) and inserts a reply
 * hanging under it. Returns the updated thread DTO.
 */
export async function replyToCommentAction(
  idOrSlug: string,
  input: { threadId: string; body: string }
): Promise<ActionState<CommentThreadDTO>> {
  const requestId = generateRequestId();
  const timer = startTimer("replyToCommentAction");
  const log = createLogger({ requestId, action: "replyToCommentAction" });

  try {
    log.info("Action started: reply to comment", {
      idOrSlug: sanitizeForLogging(idOrSlug),
    });

    const { requester, obj } = await resolveGatedObject(requestId, idOrSlug, {
      requireCapability: true,
      requireEdit: true,
    });
    const threadId = normalizeThreadId(input?.threadId);
    const body = normalizeBody(input?.body);

    const rootRows = await executeQuery(
      (db) =>
        db
          .select({ id: atriumDocComments.id })
          .from(atriumDocComments)
          .where(
            and(
              eq(atriumDocComments.objectId, obj.id),
              eq(atriumDocComments.threadId, threadId),
              isNull(atriumDocComments.parentId)
            )
          )
          .limit(1),
      "atrium.comments.findRoot"
    );
    const root = rootRows[0];
    if (!root) {
      throw new NotFoundError("Comment thread not found", { threadId });
    }

    await executeQuery(
      (db) =>
        db.insert(atriumDocComments).values({
          objectId: obj.id,
          threadId,
          parentId: root.id,
          body,
          authorUserId: authorUserIdOf(requester),
        }),
      "atrium.comments.insertReply"
    );

    const thread = await loadThreadDTO(obj.id, threadId);
    timer({ status: "success" });
    log.info("Comment reply added", { objectId: obj.id, threadId });
    return createSuccess(thread, "Reply added");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to reply to comment", {
      context: "replyToCommentAction",
      requestId,
      operation: "replyToCommentAction",
    });
  }
}

/**
 * Resolve or reopen a comment thread (edit-gated). Writes `resolved` (and the
 * resolver's id when resolving; cleared when reopening) to EVERY row of the thread
 * so the mirrored column stays consistent. 404 if the thread does not exist for
 * this object.
 */
export async function resolveCommentThreadAction(
  idOrSlug: string,
  input: { threadId: string; resolved: boolean }
): Promise<ActionState<{ threadId: string; resolved: boolean }>> {
  const requestId = generateRequestId();
  const timer = startTimer("resolveCommentThreadAction");
  const log = createLogger({ requestId, action: "resolveCommentThreadAction" });

  try {
    log.info("Action started: resolve comment thread", {
      idOrSlug: sanitizeForLogging(idOrSlug),
    });

    const { requester, obj } = await resolveGatedObject(requestId, idOrSlug, {
      requireCapability: true,
      requireEdit: true,
    });
    const threadId = normalizeThreadId(input?.threadId);
    if (typeof input?.resolved !== "boolean") {
      throw ErrorFactories.missingRequiredField("resolved");
    }
    const resolved = input.resolved;

    const updated = await executeQuery(
      (db) =>
        db
          .update(atriumDocComments)
          .set({
            resolved,
            // Record who resolved; clear it when reopening.
            resolvedByUserId: resolved ? authorUserIdOf(requester) : null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(atriumDocComments.objectId, obj.id),
              eq(atriumDocComments.threadId, threadId)
            )
          )
          .returning({ id: atriumDocComments.id }),
      "atrium.comments.resolveThread"
    );
    if (updated.length === 0) {
      throw new NotFoundError("Comment thread not found", { threadId });
    }

    timer({ status: "success" });
    log.info("Comment thread resolve state updated", {
      objectId: obj.id,
      threadId,
      resolved,
      rowsUpdated: updated.length,
    });
    return createSuccess(
      { threadId, resolved },
      resolved ? "Thread resolved" : "Thread reopened"
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to update comment thread", {
      context: "resolveCommentThreadAction",
      requestId,
      operation: "resolveCommentThreadAction",
    });
  }
}
