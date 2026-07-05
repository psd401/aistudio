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
 * - `publish`          → `publishService.publish(admin, objectId, context)` —
 *   the admin requester passes the §26.4 gate via `isAdmin`, so the exact
 *   blocked publish (destination + any recorded visibility widen) goes through.
 * - `visibility_widen` → `visibilityService.setLevel(admin, objectId, level)`.
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

import { and, desc, eq } from "drizzle-orm";
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
import type { PublishDestination } from "@/lib/content/publish-adapters/types";
import type { Requester } from "@/lib/content/types";
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
 * Resolve the session into an admin `user` Requester or throw. The requester is
 * returned (not just checked) because approve REPLAYS the blocked action AS
 * this admin — the same object that gates the action authorizes the replay.
 */
async function requireAdminRequester(
  requestId: string,
  operation: string
): Promise<AdminRequester> {
  const requester = await getUserRequester(requestId);
  if (requester.kind !== "user" || !requester.isAdmin) {
    throw ErrorFactories.authzAdminRequired(operation);
  }
  return requester;
}

/**
 * The destinations `publishService.publish` accepts. Local runtime narrowing for
 * the value read back out of the stored jsonb context — a bare `as` cast would
 * let a corrupted/legacy row reach the service and the DB enum.
 */
const PUBLISH_DESTINATION_SET: ReadonlySet<string> = new Set<PublishDestination>(
  ["intranet", "public_web", "schoology", "google", "okf"]
);

function assertPublishDestination(
  value: string | undefined
): PublishDestination {
  if (!value || !PUBLISH_DESTINATION_SET.has(value)) {
    throw ErrorFactories.invalidInput(
      "destination",
      value ?? null,
      "unknown publish destination"
    );
  }
  return value as PublishDestination;
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
  const context = request.context ?? {};
  switch (request.requestKind) {
    case "publish": {
      if (!request.objectId) {
        throw ErrorFactories.invalidInput(
          "objectId",
          null,
          "publish request has no object"
        );
      }
      const destination = assertPublishDestination(
        context.destination ?? request.destination
      );
      const visibility =
        context.visibility?.level === "public"
          ? { level: "public" as const }
          : undefined;
      await publishService.publish(requester, request.objectId, {
        destination,
        ...(visibility ? { visibility } : {}),
      });
      return true;
    }
    case "visibility_widen": {
      if (!request.objectId) {
        throw ErrorFactories.invalidInput(
          "objectId",
          null,
          "visibility request has no object"
        );
      }
      // The gate only ever fires for a widen to `public`; the recorded level is
      // read back (rather than hard-coded) so the row remains the single truth.
      const level = context.level ?? "public";
      await visibilityService.setLevel(requester, request.objectId, { level });
      return true;
    }
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
export async function listPendingApprovalsAction(): Promise<
  ActionState<PendingApprovalDTO[]>
> {
  const requestId = generateRequestId();
  const timer = startTimer("listPendingApprovalsAction");
  const log = createLogger({ requestId, action: "listPendingApprovalsAction" });

  try {
    await requireAdminRequester(requestId, "listPendingApprovals");

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
          .where(eq(contentPublishRequests.status, "pending"))
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
    const requester = await requireAdminRequester(
      requestId,
      "approvePublishRequest"
    );

    const request = await loadRequest(id);
    if (request.status !== "pending") {
      throw ErrorFactories.invalidInput(
        "id",
        id,
        "request has already been decided"
      );
    }

    // Replay FIRST: if the recorded action cannot be applied, the row must stay
    // pending (the error propagates before the status write below).
    const replayed = await replayApprovedRequest(requester, request, log);

    // Conditional on still-pending so a concurrent decision cannot be
    // overwritten. Zero rows here means another admin decided mid-replay — the
    // replay already happened, so log it rather than pretend it did not.
    const updated = await executeQuery(
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
      "atrium.approvals.markApproved"
    );
    if (updated.length === 0) {
      log.warn("Request was decided concurrently after replay", { id });
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
    const requester = await requireAdminRequester(
      requestId,
      "denyPublishRequest"
    );

    if (!note?.trim()) {
      throw ErrorFactories.missingRequiredField("note");
    }

    const request = await loadRequest(id);
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
