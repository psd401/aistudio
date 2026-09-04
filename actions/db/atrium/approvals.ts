"use server"

/**
 * Atrium §26.4 approval-queue server actions (Epic #1059 completion)
 *
 * The admin surface over `content_publish_requests` (migration 096): list the
 * pending queue, approve (which REPLAYS the recorded action as the approving
 * admin), or deny (records only). Every action is admin-gated — the queue holds
 * requests to expose content publicly, the district's highest-governance path.
 *
 * Replay semantics on approve:
 * - `publish`          → `publishService.publish(admin, objectId, context)`, plus
 *   a separate `visibilityService.setLevel` first when a pre-#1726 row recorded a
 *   bundled widen (publishing no longer carries visibility) —
 *   the admin requester passes the §26.4 gate via `isAdmin`, so the exact
 *   blocked publish (destination + any recorded visibility widen) goes through,
 *   PINNED to the raise-time version (`context.versionId`, issue #1118) so the
 *   admin publishes the reviewed content, not a newer unreviewed head.
 * - `visibility_widen` → `visibilityService.setLevel(admin, objectId, level)`.
 *   Also the row an unauthorized public CREATE lands on (the object was created
 *   private; approve widens it to public).
 * - `unpublish`        → `publishService.unpublish(admin, objectId, destination)`
 *   — a removal, idempotent (a no-op if already offline).
 * - `export`           → NOT replayed. The OKF bundle is produced and handed to
 *   the ORIGINAL caller at call time (inline JSON + presigned URL) — a bundle
 *   built here by the approving admin would go nowhere (there is no channel back
 *   to the requester), and it would snapshot approval-time content rather than
 *   what was reviewed. Approval records the decision; the exporter re-runs.
 *
 * The replayed call may itself throw (e.g. a destination adapter that is not
 * yet implemented) — that error surfaces to the admin and the row stays
 * `pending` so the decision can be retried later.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import {
  createSuccess,
  handleError,
  ErrorFactories,
} from "@/lib/error-utils";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  contentObjects,
  contentPublishRequests,
  users,
  type ContentPublishRequestContext,
  type ContentPublishRequestKind,
  type ContentPublishRequestRow,
} from "@/lib/db/schema";
import { publishService } from "@/lib/content/publish-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { isPublishDestination } from "@/lib/content/validators";
import type { PublishDestination } from "@/lib/content/publish-adapters/types";
import type { Requester } from "@/lib/content/types";
import {
  collectionAccessSnapshot,
  isCollectionApprover,
} from "@/lib/content/collection-access";
import type { ActionState } from "@/types";
import { getUserRequester } from "./requester";

/** One pending queue entry, joined with its object + requesting user. */
export interface PendingApprovalDTO {
  id: string;
  objectId: string | null;
  objectTitle: string | null;
  objectSlug: string | null;
  requestKind: ContentPublishRequestKind;
  destination: string;
  context: ContentPublishRequestContext;
  requesterLabel: string | null;
  requestedByUserId: number | null;
  requesterEmail: string | null;
  createdAt: string | null;
}

type AdminRequester = Extract<Requester, { kind: "user" }>;

/**
 * The set of collection ids this requester may approve publishes out of, or
 * `null` for an administrator (who may approve anything).
 *
 * Migration 178 made the approver roster per-collection and configurable — a
 * section can name its own approvers by role, group, or person — so the queue
 * is no longer an admin-only surface. A department's SOP owner should clear
 * their own section's queue without district admin involvement.
 */
async function approvableCollectionIds(
  req: Requester
): Promise<Set<string> | null> {
  if (req.kind === "user" && req.isAdmin) return null;
  const access = await collectionAccessSnapshot(req);
  const ids = new Set<string>();
  for (const collection of access.collections) {
    if (!collection.requiresApproval) continue;
    if (isCollectionApprover(req, collection, access)) ids.add(collection.id);
  }
  return ids;
}

/**
 * Coarse eligibility, checked BEFORE any request row is loaded.
 *
 * Migration 178 made the per-request decider set depend on the request's
 * collection, which means the row has to be read before the precise check can
 * run. Done naively that hands an unauthorized caller an existence oracle: a
 * bad id 404s while a real id they cannot decide returns "forbidden", so they
 * can enumerate valid request ids. This restores the old uniform rejection for
 * anyone who cannot decide ANYTHING, without giving up the per-collection
 * roster.
 *
 * Callers who clear this still cannot learn about requests outside their own
 * sections — `assertMayDecide` folds that case into the not-found response.
 */
async function requireEligibleDecider(
  requestId: string,
  operation: string
): Promise<AdminRequester> {
  const requester = await getUserRequester(requestId);
  if (requester.kind !== "user") {
    throw ErrorFactories.authzAdminRequired(operation);
  }
  const approvable = await approvableCollectionIds(requester);
  // `null` = administrator (decides anything). An empty set = approves nothing.
  if (approvable != null && approvable.size === 0) {
    throw ErrorFactories.authzAdminRequired(operation);
  }
  return requester;
}

/**
 * The precise per-request check, run once the row is loaded.
 *
 * An eligible caller who may not decide THIS request is answered exactly like
 * one asking about a request that does not exist — same error, same shape — so
 * clearing the coarse gate does not turn into an oracle for other sections'
 * queues.
 *
 * Self-approval is the one deliberate exception to that masking: the requester
 * obviously knows their own request exists, so a specific message costs nothing
 * and a generic "not found" would just be baffling. It enforces segregation of
 * duties and cannot strand anything — whoever raised a request was by
 * definition not an approver at raise time, since an approver's publish is
 * never queued.
 */
async function assertMayDecide(
  requester: AdminRequester,
  request: ContentPublishRequestRow,
  id: string
): Promise<void> {
  if (
    request.requestedByUserId != null &&
    request.requestedByUserId === requester.userId
  ) {
    throw ErrorFactories.authzToolAccessDenied(
      "Approving your own request is not permitted — another approver must review it"
    );
  }

  if (requester.isAdmin) return;

  // Non-admin: must approve the collection THIS request's object lives in. An
  // object-less request (`export`) has no collection to derive a roster from,
  // so it stays administrator-only.
  const objectId = request.objectId;
  const [obj] = objectId
    ? await executeQuery(
        (db) =>
          db
            .select({ collectionId: contentObjects.collectionId })
            .from(contentObjects)
            .where(eq(contentObjects.id, objectId))
            .limit(1),
        "atrium.approvals.loadRequestCollection"
      )
    : [undefined];

  const allowed = await approvableCollectionIds(requester);
  if (allowed == null || !obj?.collectionId || !allowed.has(obj.collectionId)) {
    // Deliberately the NOT-FOUND error, not a forbidden one — see the docblock.
    throw ErrorFactories.dbRecordNotFound("content_publish_requests", id);
  }
}

/**
 * Runtime narrowing for the destination read back out of the stored jsonb
 * context — a bare `as` cast would let a corrupted/legacy row reach the service
 * and the DB enum. The membership test is the shared `isPublishDestination`
 * guard (`lib/content/validators.ts`, derived from the canonical
 * `PUBLISH_DESTINATIONS` list — the FULL set including `okf`); only the error
 * shape (`ErrorFactories.invalidInput`) stays local to this action surface.
 */
function assertPublishDestination(
  value: string | undefined
): PublishDestination {
  if (!value || !isPublishDestination(value)) {
    throw ErrorFactories.invalidInput(
      "destination",
      value ?? null,
      "unknown publish destination"
    );
  }
  return value;
}

/**
 * Return the request's object id or throw — every replayable kind is
 * object-scoped (only `export` is object-less, and it never replays).
 */
function requireRequestObjectId(
  request: ContentPublishRequestRow,
  kindLabel: string
): string {
  if (!request.objectId) {
    throw ErrorFactories.invalidInput(
      "objectId",
      null,
      `${kindLabel} request has no object`
    );
  }
  return request.objectId;
}

/**
 * Replay a `publish` request: publish the recorded destination, and — issue
 * #1118 — PIN the raise-time version (`context.versionId`) so the admin
 * publishes the reviewed content, not a newer head. `versionId` is absent on
 * pre-#1118 rows → publish the current head.
 *
 * A recorded `context.visibility` widen is replayed as a SEPARATE
 * `visibilityService.setLevel` call, before the publish. Since #1726 publishing
 * never touches visibility, so the two halves of a pre-#1726 queued row (which
 * were raised as one bundled request) are replayed as the two writes they
 * actually are. Ordering matters: widen first, so that if the widen is what the
 * approver was gating and it fails, nothing goes live.
 *
 * Only `public` is replayable here — that is the only level the §26.4 gate ever
 * recorded, and it is the level the admin approved.
 */
async function replayPublish(
  requester: AdminRequester,
  request: ContentPublishRequestRow
): Promise<void> {
  const objectId = requireRequestObjectId(request, "publish");
  const context = request.context ?? {};
  const destination = assertPublishDestination(
    context.destination ?? request.destination
  );
  const versionId =
    typeof context.versionId === "string" ? context.versionId : undefined;
  if (context.visibility?.level === "public") {
    await visibilityService.setLevel(requester, objectId, { level: "public" });
  }
  await publishService.publish(requester, objectId, {
    destination,
    ...(versionId ? { versionId } : {}),
  });
}

/**
 * Replay an `unpublish` request: take the recorded destination offline. A
 * removal — idempotent (a no-op if the object is already offline there).
 */
async function replayUnpublish(
  requester: AdminRequester,
  request: ContentPublishRequestRow
): Promise<void> {
  const objectId = requireRequestObjectId(request, "unpublish");
  const context = request.context ?? {};
  const destination = assertPublishDestination(
    context.destination ?? request.destination
  );
  await publishService.unpublish(requester, objectId, destination);
}

/**
 * Replay a `visibility_widen` request: widen the object to the recorded level.
 * The gate only ever fires for a widen to `public`; the recorded level is read
 * back (rather than hard-coded) so the row remains the single source of truth.
 */
async function replayVisibilityWiden(
  requester: AdminRequester,
  request: ContentPublishRequestRow
): Promise<void> {
  const objectId = requireRequestObjectId(request, "visibility");
  const level = (request.context ?? {}).level ?? "public";
  await visibilityService.setLevel(requester, objectId, { level });
}

/**
 * Replay the request's recorded action as the approving admin. Returns whether
 * anything was replayed (`export` is decision-only — see the module header).
 * Throws when the recorded row is malformed or the replayed service call fails;
 * the caller leaves the row `pending` in that case.
 */
async function replayApprovedRequest(
  requester: AdminRequester,
  request: ContentPublishRequestRow,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  switch (request.requestKind) {
    case "publish":
      await replayPublish(requester, request);
      return true;
    case "unpublish":
      await replayUnpublish(requester, request);
      return true;
    case "visibility_widen":
      await replayVisibilityWiden(requester, request);
      return true;
    case "export":
      // Decision-only — see the module header for why exports never replay.
      log.info("Export request approved without replay", { id: request.id });
      return false;
  }
}

/** Load one request row by id, or throw a not-found error. */
async function loadRequest(id: string): Promise<ContentPublishRequestRow> {
  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(contentPublishRequests)
        .where(eq(contentPublishRequests.id, id))
        .limit(1),
    "atrium.approvals.load"
  );
  const request = rows[0];
  if (!request) {
    throw ErrorFactories.dbRecordNotFound("content_publish_requests", id);
  }
  return request;
}

/**
 * List the pending §26.4 approval queue (admin only), newest first, with the
 * object's title/slug and the requesting user's email joined in for display.
 */
/**
 * Whether the caller approves publishes for at least one collection — the
 * entry check for /admin/atrium's non-admin path.
 *
 * Returns a boolean rather than throwing so the page can 404 (mask the
 * surface's existence) instead of surfacing an authorization error.
 */
export async function isCollectionApproverAction(): Promise<
  ActionState<boolean>
> {
  const requestId = generateRequestId();
  try {
    const requester = await getUserRequester(requestId);
    const approvable = await approvableCollectionIds(requester);
    // `null` = administrator (approves everything).
    return createSuccess(approvable == null || approvable.size > 0, "Checked");
  } catch (error) {
    return handleError(error, "Failed to check approver status", {
      context: "isCollectionApproverAction",
      requestId,
      operation: "isCollectionApproverAction",
    });
  }
}

export async function listPendingApprovalsAction(): Promise<
  ActionState<PendingApprovalDTO[]>
> {
  const requestId = generateRequestId();
  const timer = startTimer("listPendingApprovalsAction");
  const log = createLogger({ requestId, action: "listPendingApprovalsAction" });

  try {
    // Admins see the whole queue; a collection approver sees only the requests
    // they can actually act on. `null` means "no restriction" (administrator);
    // an EMPTY set means this caller approves nothing, which must yield an
    // empty list rather than the unfiltered queue — the difference between the
    // two is why this is `Set | null` and not a bare set.
    const viewer = await getUserRequester(requestId);
    const approvable = await approvableCollectionIds(viewer);
    if (approvable != null && approvable.size === 0) {
      throw ErrorFactories.authzAdminRequired("listPendingApprovals");
    }

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            id: contentPublishRequests.id,
            objectId: contentPublishRequests.objectId,
            requestKind: contentPublishRequests.requestKind,
            destination: contentPublishRequests.destination,
            context: contentPublishRequests.context,
            requesterLabel: contentPublishRequests.requesterLabel,
            requestedByUserId: contentPublishRequests.requestedByUserId,
            createdAt: contentPublishRequests.createdAt,
            objectTitle: contentObjects.title,
            objectSlug: contentObjects.slug,
            requesterEmail: users.email,
          })
          .from(contentPublishRequests)
          .leftJoin(
            contentObjects,
            eq(contentPublishRequests.objectId, contentObjects.id)
          )
          .leftJoin(
            users,
            eq(contentPublishRequests.requestedByUserId, users.id)
          )
          .where(
            approvable == null
              ? eq(contentPublishRequests.status, "pending")
              : and(
                  eq(contentPublishRequests.status, "pending"),
                  // Non-admin approvers see only their own sections' requests.
                  // Object-less (`export`) rows have no collection and so are
                  // excluded here — they stay administrator-only.
                  inArray(contentObjects.collectionId, [...approvable])
                )
          )
          .orderBy(desc(contentPublishRequests.createdAt)),
      "atrium.approvals.listPending"
    );

    const data: PendingApprovalDTO[] = rows.map((row) => ({
      id: row.id,
      objectId: row.objectId,
      objectTitle: row.objectTitle,
      objectSlug: row.objectSlug,
      requestKind: row.requestKind,
      destination: row.destination,
      context: row.context ?? {},
      requesterLabel: row.requesterLabel,
      requestedByUserId: row.requestedByUserId,
      requesterEmail: row.requesterEmail,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    }));

    timer({ status: "success" });
    log.info("Listed pending approvals", { count: data.length });
    return createSuccess(data, "Pending approvals loaded");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load pending approvals", {
      context: "listPendingApprovalsAction",
      requestId,
      operation: "listPendingApprovalsAction",
    });
  }
}

/**
 * Approve a pending request (admin only): replay the recorded action as the
 * approving admin, then mark the row approved. A replay failure surfaces as the
 * action's error and leaves the row `pending`.
 */
export async function approvePublishRequestAction(
  id: string,
  note?: string
): Promise<ActionState<{ id: string; replayed: boolean }>> {
  const requestId = generateRequestId();
  const timer = startTimer("approvePublishRequestAction");
  const log = createLogger({
    requestId,
    action: "approvePublishRequestAction",
  });

  try {
    log.info("Action started: approve publish request", {
      id,
      hasNote: Boolean(note),
    });
    // Coarse gate FIRST, so a caller who can decide nothing is rejected without
    // the row load ever happening — otherwise "bad id" and "real id I may not
    // touch" answer differently and become an enumeration oracle.
    const requester = await requireEligibleDecider(
      requestId,
      "approvePublishRequest"
    );
    // Then the row, then the precise per-request check: who may decide depends
    // on which collection the object sits in, so the row is an INPUT to that
    // gate rather than something read after passing it.
    const request = await loadRequest(id);
    await assertMayDecide(requester, request, id);

    if (request.status !== "pending") {
      throw ErrorFactories.invalidInput(
        "id",
        id,
        "request has already been decided"
      );
    }

    // CLAIM FIRST (atomic compare-and-set pending→approved) so the replay side
    // effect runs AT MOST ONCE and can never race a concurrent deny. The prior
    // ordering (replay, then conditional mark) let a deny land mid-replay: the
    // publish still went live while the row ended up `denied`. Here, whichever
    // decider flips the row out of `pending` first wins; the loser sees zero
    // rows and aborts WITHOUT replaying.
    const claimed = await executeQuery(
      (db) =>
        db
          .update(contentPublishRequests)
          .set({
            status: "approved",
            decidedByUserId: requester.userId,
            decidedAt: new Date(),
            decisionNote: note?.trim() ? note.trim() : null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(contentPublishRequests.id, id),
              eq(contentPublishRequests.status, "pending")
            )
          )
          .returning({ id: contentPublishRequests.id }),
      "atrium.approvals.claimApprove"
    );
    if (claimed.length === 0) {
      throw ErrorFactories.invalidInput(
        "id",
        id,
        "request has already been decided"
      );
    }

    // Replay the recorded action as the approving admin. If it fails, REVERT the
    // claim to `pending` so the request stays actionable (retry or deny) rather
    // than stuck `approved` with nothing published. A process crash mid-replay
    // leaves the row `approved` but not live — a visible, admin-recoverable state
    // (re-trigger the publish), never a denied-but-published one.
    let replayed: boolean;
    try {
      replayed = await replayApprovedRequest(requester, request, log);
    } catch (replayError) {
      await executeQuery(
        (db) =>
          db
            .update(contentPublishRequests)
            .set({
              status: "pending",
              decidedByUserId: null,
              decidedAt: null,
              decisionNote: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(contentPublishRequests.id, id),
                eq(contentPublishRequests.status, "approved")
              )
            ),
        "atrium.approvals.revertClaimOnReplayFailure"
      );
      throw replayError;
    }

    timer({ status: "success" });
    log.info("Publish request approved", { id, replayed });
    return createSuccess(
      { id, replayed },
      replayed
        ? "Request approved and the publish was applied"
        : "Request approved (export must be re-run by the requester)"
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to approve publish request", {
      context: "approvePublishRequestAction",
      requestId,
      operation: "approvePublishRequestAction",
    });
  }
}

/**
 * Deny a pending request (admin only). Records the decision + a required note
 * explaining why; nothing is replayed or published.
 */
export async function denyPublishRequestAction(
  id: string,
  note: string
): Promise<ActionState<{ id: string }>> {
  const requestId = generateRequestId();
  const timer = startTimer("denyPublishRequestAction");
  const log = createLogger({ requestId, action: "denyPublishRequestAction" });

  try {
    log.info("Action started: deny publish request", { id });
    // Same ordering as approve, for the same reason — see there.
    const requester = await requireEligibleDecider(
      requestId,
      "denyPublishRequest"
    );
    const request = await loadRequest(id);
    await assertMayDecide(requester, request, id);

    if (!note?.trim()) {
      throw ErrorFactories.missingRequiredField("note");
    }

    if (request.status !== "pending") {
      throw ErrorFactories.invalidInput(
        "id",
        id,
        "request has already been decided"
      );
    }

    const updated = await executeQuery(
      (db) =>
        db
          .update(contentPublishRequests)
          .set({
            status: "denied",
            decidedByUserId: requester.userId,
            decidedAt: new Date(),
            decisionNote: note.trim(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(contentPublishRequests.id, id),
              eq(contentPublishRequests.status, "pending")
            )
          )
          .returning({ id: contentPublishRequests.id }),
      "atrium.approvals.markDenied"
    );
    if (updated.length === 0) {
      // Pending at load time but decided by the time we wrote — concurrent admin.
      throw ErrorFactories.invalidInput(
        "id",
        id,
        "request was decided concurrently"
      );
    }

    timer({ status: "success" });
    log.info("Publish request denied", { id });
    return createSuccess({ id }, "Request denied");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to deny publish request", {
      context: "denyPublishRequestAction",
      requestId,
      operation: "denyPublishRequestAction",
    });
  }
}
