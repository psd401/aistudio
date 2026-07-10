/**
 * Content Publish Requests Table Schema
 *
 * Epic #1059 completion — the durable §26.4 approval queue. One row per blocked
 * public exposure raised by `raisePublishApprovalRequired`
 * (lib/content/helpers.ts): an unauthorized publish to a public destination, a
 * visibility widen to `public`, or a public-audience OKF export. Admins decide
 * rows at /admin/atrium; approving REPLAYS the recorded action (except
 * `export` — see `ContentPublishRequestKind`).
 *
 * `object_id` is nullable because `export` requests are collection-scoped (the
 * OKF exporter raises with a collection id only); a DB CHECK enforces it for the
 * other kinds. `destination` is text (NOT the publish_destination enum) because
 * `visibility_widen` rows record the exposure target (`'public'`), which is not
 * a publish destination.
 *
 * See migration 096 and docs/features/atrium-design-spec.md §26.4.
 */

import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contentObjects } from "./content-objects";
import { users } from "./users";
import { agentIdentities } from "./agent-identities";

/**
 * What the blocked caller was trying to do:
 * - `publish` — `publishService.publish` to a public destination, or with a
 *   bundled visibility widen to public. Replayed via `publishService.publish`,
 *   PINNED to the raise-time version (`context.versionId`) so the admin approves
 *   the reviewed content, not whatever the author has since edited into the head.
 * - `visibility_widen` — `visibilityService.setLevel` widening to `public`.
 *   Replayed via `visibilityService.setLevel`. Also the request an unauthorized
 *   public CREATE lands on: the object is created PRIVATE and this row queues the
 *   widen to public (issue #1118 — create is not blocked outright).
 * - `unpublish` — `publishService.unpublish` from a public destination without
 *   the §26.4 authority. Replayed cleanly via `publishService.unpublish` (a
 *   removal is idempotent; if already offline the replay is a no-op).
 * - `export` — a public-audience OKF bundle. NOT replayed on approve: the bundle
 *   is produced and handed to the original caller at call time (a bundle built by
 *   the approving admin would go nowhere, and would snapshot approval-time
 *   content, not request-time). Approval only records the decision; the exporter
 *   re-runs the export.
 */
export type ContentPublishRequestKind =
  | "publish"
  | "visibility_widen"
  | "unpublish"
  | "export";

export type ContentPublishRequestStatus = "pending" | "approved" | "denied";

/**
 * Exactly what is needed to REPLAY the blocked action on approve (plus display
 * fields), shaped per kind:
 * - `publish`: `{ destination, slug?, versionId?, visibility? }` — `versionId`
 *   pins the raise-time head so approve publishes the REVIEWED version, not a
 *   later edit (issue #1118); `visibility` (`{ level: "public" }`) is present when
 *   the caller bundled a widen to public (the in-tx widen branch, or a public
 *   destination whose caller also asked to widen).
 * - `visibility_widen`: `{ level: "public" }`.
 * - `unpublish`: `{ destination }` — the public destination to take offline.
 * - `export`: `{ collectionId, audience: "public" }` (display only, no replay).
 */
export interface ContentPublishRequestContext {
  destination?: string;
  slug?: string;
  /**
   * The content version to publish on replay — pinned at raise time so an admin
   * approves the reviewed content even if the author kept editing (issue #1118).
   * Absent on rows written before this change; replay then falls back to the
   * object's current head (the pre-#1118 behaviour).
   */
  versionId?: string;
  visibility?: { level: "public" };
  level?: "public";
  collectionId?: string;
  audience?: "public";
}

export const contentPublishRequests = pgTable(
  "content_publish_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The content object; NULL only for `export` (collection-scoped). */
    objectId: uuid("object_id").references(() => contentObjects.id, {
      onDelete: "cascade",
    }),
    requestKind: text("request_kind")
      .$type<ContentPublishRequestKind>()
      .notNull(),
    /**
     * `publish` → the publish destination; `visibility_widen` → `'public'` (the
     * exposure target); `export` → `'okf'`.
     */
    destination: text("destination").notNull(),
    context: jsonb("context")
      .$type<ContentPublishRequestContext>()
      .default({})
      .notNull(),
    /** The requesting human (user / delegated-agent requesters). */
    requestedByUserId: integer("requested_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    /** The autonomous agent identity, when the requester is one. */
    requestedByAgentId: uuid("requested_by_agent_id").references(
      () => agentIdentities.id,
      { onDelete: "set null" }
    ),
    requesterLabel: text("requester_label"),
    status: text("status")
      .$type<ContentPublishRequestStatus>()
      .default("pending")
      .notNull(),
    decidedByUserId: integer("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // Pending-dedupe: at most one open request per (object, kind, destination).
    uniqueIndex("uq_cpr_pending")
      .on(t.objectId, t.requestKind, t.destination)
      .where(sql`${t.status} = 'pending'`),
    // Export requests (NULL object_id) dedupe on the bundled collection instead.
    uniqueIndex("uq_cpr_pending_export")
      .on(sql`(${t.context}->>'collectionId')`, t.requestKind, t.destination)
      .where(sql`${t.status} = 'pending' AND ${t.objectId} IS NULL`),
    index("idx_cpr_status_created").on(t.status, t.createdAt),
  ]
);

export type ContentPublishRequestRow =
  typeof contentPublishRequests.$inferSelect;
export type NewContentPublishRequestRow =
  typeof contentPublishRequests.$inferInsert;
