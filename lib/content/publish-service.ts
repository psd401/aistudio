/**
 * Atrium publish service
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). Owns the canonical
 * `content_publications` row — the durable record that "version V of object O is
 * live at destination D" — and the visibility-widening that publishing implies.
 *
 * Flow (`publish`):
 *  1. Load the object's owner / visibility / current head / slug.
 *  2. `canView` gate FIRST (mask existence: a non-viewable object 404s, never
 *     403s, so private ids cannot be enumerated), then `assertCanEdit`.
 *  3. Destination gate (`public_web` is a later phase; see below).
 *  4. Require a working head (`current_version_id`); nothing to publish otherwise.
 *  5. In a single transaction: optionally apply visibility grants + widen the
 *     object's visibility and mark it `published`, then upsert the publication
 *     row (idempotent on `(object_id, destination)`).
 *  6. AFTER the transaction commits, call the destination adapter for any
 *     external side effect (drizzle-client anti-pattern: external IO inside a tx).
 *
 * The adapter (`./publish-adapters`) abstracts *where a published version becomes
 * live*. Phase 1 wires only the reader-backed `intranet` adapter (a no-op); the
 * other destinations throw until their phase lands.
 *
 * See docs/features/atrium-design-spec.md §15 (publishing).
 */

import { and, eq } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import { contentObjects, contentPublications } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import {
  actorKindOf,
  assertCanEdit,
  authorUserIdOf,
  canPublishPublic,
} from "./helpers";
import { visibilityService } from "./visibility-service";
import { contentEvents } from "./events";
import { NotFoundError, ValidationError, ApprovalRequiredError } from "./errors";
import type { PublishAdapter, PublishDestination } from "./publish-adapters/types";
import { intranetAdapter } from "./publish-adapters/intranet";
import type {
  Requester,
  VisibilityGrant,
  VisibilityLevel,
} from "./types";

/** Per-publish input: the destination plus optional visibility widening. */
export interface PublishInput {
  destination: PublishDestination;
  /**
   * When provided, the object's visibility is set to `level` (and, for `group`,
   * its grants replaced with `grants`) inside the publish transaction and the
   * object is marked `published`. Omit to publish without changing visibility.
   */
  visibility?: {
    level: VisibilityLevel;
    grants?: VisibilityGrant[];
  };
}

/**
 * The destination adapter registry. Phase 1 wires only the reader-backed
 * `intranet` adapter; the remaining destinations throw until their phase lands,
 * so a stray `public_web`/`schoology`/`google` publish fails loudly rather than
 * silently writing a publication row with no live side effect.
 */
const notImplemented = (destination: PublishDestination): PublishAdapter => ({
  destination,
  implemented: false,
  async publish(): Promise<{ externalRef: string | null }> {
    throw new ValidationError(
      `Publishing to '${destination}' is not implemented in Phase 1`,
      { destination }
    );
  },
});

const adapters: Record<PublishDestination, PublishAdapter> = {
  intranet: intranetAdapter,
  public_web: notImplemented("public_web"),
  schoology: notImplemented("schoology"),
  google: notImplemented("google"),
};

/** A loaded object's fields the publish path needs. */
interface PublishableObject {
  ownerUserId: number;
  visibilityLevel: VisibilityLevel;
  currentVersionId: string | null;
  slug: string;
  title: string;
  collectionId: string | null;
}

/** Load the publish-relevant columns for an object, or null when absent. */
async function loadPublishable(
  objectId: string
): Promise<PublishableObject | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          ownerUserId: contentObjects.ownerUserId,
          visibilityLevel: contentObjects.visibilityLevel,
          currentVersionId: contentObjects.currentVersionId,
          slug: contentObjects.slug,
          title: contentObjects.title,
          collectionId: contentObjects.collectionId,
        })
        .from(contentObjects)
        .where(eq(contentObjects.id, objectId))
        .limit(1),
    "publish.loadPublishable"
  );
  return rows[0] ?? null;
}

export const publishService = {
  /**
   * Publish (or republish) an object's working head to a destination. Idempotent
   * on `(object_id, destination)`: republishing updates the live version in
   * place. Returns the publication row id and the version that is now live.
   */
  async publish(
    req: Requester,
    objectId: string,
    input: PublishInput,
    /**
     * Surface-resolved authorization context. `hasPublishPublicCapability` lets
     * the in-app server-action surface pass a non-admin human's
     * `content.publish_public` capability into the §26.4 gate; API/MCP surfaces
     * omit it (agents are scope-gated, admins pass via `req.isAdmin`).
     */
    opts: { hasPublishPublicCapability?: boolean } = {}
  ): Promise<{ publicationId: string; publishedVersionId: string }> {
    const log = createLogger({ action: "publish.publish" });

    // Load owner + visibility + head + slug, and run the permission checks
    // OUTSIDE the transaction. `canView` may issue its own `executeQuery` (grant
    // lookup), which acquires a second pooled connection — doing that inside an
    // `executeTransaction` callback (which already holds one) risks a pool
    // deadlock under concurrency (mirrors versionService.rollback).
    const obj = await loadPublishable(objectId);
    if (!obj) {
      throw new NotFoundError("Content not found", { objectId });
    }
    // Mask existence from callers who cannot view the object *before* revealing
    // edit/publish state: a non-viewable object must 404 (not 403), so private
    // object ids cannot be enumerated (403 = exists, 404 = absent).
    const viewable = await visibilityService.canView(req, {
      id: objectId,
      ownerUserId: obj.ownerUserId,
      visibilityLevel: obj.visibilityLevel,
    });
    if (!viewable) {
      throw new NotFoundError("Content not found", { objectId });
    }
    assertCanEdit(req, obj.ownerUserId);

    // §26.4 — the public-publish gate. Targeting a public-facing destination, or
    // widening visibility to `public`, requires `content:publish_public`:
    // autonomous agents never hold it, under-scoped delegated agents lack it, and
    // non-admin humans need the capability. When the caller is not authorized,
    // emit the approval-queue signal and raise the structured ApprovalRequiredError
    // (surfaces map it to 202 / `approval_required`) — never silently publish
    // unreviewed content to families/the public.
    //
    // Gate on an ACTUAL public exposure, not the target value alone: widening
    // visibility to `public` only exposes when the object is not ALREADY public
    // (`obj.visibilityLevel !== "public"`). Re-saving already-public content by a
    // non-admin owner (visibility unchanged) is an idempotent no-op that must NOT
    // spuriously throw `ApprovalRequiredError` + emit the approval event — a
    // widen that changes nothing is not a new exposure to review. A `public_web`
    // destination is always public-facing (its adapter is unimplemented today, so
    // there is no already-live state to compare against).
    const isPublicFacing =
      input.destination === "public_web" ||
      (input.visibility?.level === "public" &&
        obj.visibilityLevel !== "public");
    if (
      isPublicFacing &&
      !canPublishPublic(req, opts.hasPublishPublicCapability ?? false)
    ) {
      // Fire-and-forget (best-effort, matches the audit-write pattern):
      // `contentEvents.emit` swallows its own errors (`snsPublishBestEffort` never
      // throws), so awaiting it only adds an SNS round-trip to the response path.
      void contentEvents.emit("content.public_publish_requested", {
        objectId,
        slug: obj.slug,
        destination: input.destination,
        actorKind: actorKindOf(req),
        agentLabel: req.kind === "user" ? null : req.agentLabel,
      });
      throw new ApprovalRequiredError(
        "Publishing to a public destination requires approval",
        { destination: input.destination, objectId }
      );
    }

    // Nothing is live without a working head: the publication's
    // `published_version_id` is NOT NULL, so a null head cannot be published.
    if (obj.currentVersionId == null) {
      throw new ValidationError("Nothing to publish", { objectId });
    }
    const publishedVersionId = obj.currentVersionId;

    // The actor recording the publish. Guests/autonomous agents have no user id;
    // `published_by` is nullable, so a null here is persisted as "system".
    const publishedBy = authorUserIdOf(req);

    const adapter = adapters[input.destination];

    // A destination whose adapter is not yet implemented (public_web/schoology/
    // google — later phases) must fail BEFORE the transaction. Otherwise the
    // status/visibility widening below commits, then the post-commit adapter call
    // throws, and the object is left flagged `public` (canView treats
    // visibilityLevel === "public" as world-readable regardless of publication
    // status) with no live publication — a "failed" publish that silently exposed
    // the content. Blocking here writes nothing. This runs AFTER the §26.4 gate so
    // an unauthorized caller still gets the approval signal, not this error. (When
    // a real external adapter lands, its runtime failures will instead need
    // compensating revert of the committed status/visibility.)
    if (adapter.implemented === false) {
      throw new ValidationError(
        `Publishing to '${input.destination}' is not yet available`,
        { destination: input.destination }
      );
    }

    const publicationId = await executeTransaction(
      async (tx: DbTransaction) => {
        // Lock the content row FOR UPDATE at the start of the transaction so two
        // concurrent publishes of the same object serialize here rather than racing
        // through `applyGrantsInTx`'s DELETE (no contention) and both reaching the
        // grant INSERT — where the second would hit the `uq_cvg` unique constraint
        // and roll back as an opaque 500. The standalone `visibilityService.setLevel`
        // acquires the same lock; mirror it here. The row was confirmed to exist via
        // `loadPublishable` above, but re-select inside the tx (a concurrent delete
        // could have removed it between the load and this lock); a missing row 404s.
        const locked = await tx
          .select({ id: contentObjects.id })
          .from(contentObjects)
          .where(eq(contentObjects.id, objectId))
          .for("update")
          .limit(1);
        if (!locked[0]) {
          throw new NotFoundError("Content not found", { objectId });
        }

        // Optionally widen visibility in the same tx so the status change and
        // any grant updates are atomic. `setLevelInTx` replaces the level + (for
        // group) its grants, enforcing the group-needs-grants guard. When a
        // visibility change is requested, fold `status: "published"` into its
        // single level UPDATE (via `extraSet`) so the row is touched once;
        // otherwise issue a standalone status-only UPDATE.
        if (input.visibility) {
          await visibilityService.setLevelInTx(tx, objectId, input.visibility, {
            status: "published",
          });
        } else {
          await tx
            .update(contentObjects)
            .set({
              status: "published",
              updatedAt: new Date(),
            })
            .where(eq(contentObjects.id, objectId));
        }

        // Idempotent upsert: republishing the same destination updates the live
        // version + status in place (unique on (object_id, destination)).
        const upserted = await tx
          .insert(contentPublications)
          .values({
            objectId,
            destination: input.destination,
            publishedVersionId,
            status: "live",
            publishedBy,
          })
          .onConflictDoUpdate({
            target: [
              contentPublications.objectId,
              contentPublications.destination,
            ],
            set: {
              publishedVersionId,
              status: "live",
              publishedBy,
              updatedAt: new Date(),
            },
          })
          .returning({ id: contentPublications.id });

        const row = upserted[0];
        if (!row) {
          // INSERT ... RETURNING should always yield a row; guard rather than crash.
          throw new ValidationError("Failed to record publication", { objectId });
        }
        return row.id;
      },
      "publish.publish"
    );

    // Destination side effect runs AFTER the transaction commits (never inside
    // it): external IO in a transaction is a drizzle-client anti-pattern. The
    // intranet adapter is a no-op; `external_ref` stays whatever the row holds.
    //
    // The publication row was committed as `status: "live"` above. If the adapter
    // throws (a real non-no-op adapter — Schoology/Google — failing to notify the
    // destination), the row would otherwise be a dangling "live" record for a
    // version that never went live downstream. Compensate: flip the row to
    // `failed` so a retry re-runs the adapter, and re-throw so the caller sees the
    // failure. The intranet adapter cannot reach this path (it never throws).
    try {
      await adapter.publish({
        objectId,
        slug: obj.slug,
        versionId: publishedVersionId,
        title: obj.title,
        collectionId: obj.collectionId,
      });
    } catch (adapterError) {
      log.error("Publish adapter failed; marking publication failed", {
        objectId,
        destination: input.destination,
        publicationId,
        error: adapterError instanceof Error ? adapterError.message : String(adapterError),
      });
      await executeQuery(
        (db) =>
          db
            .update(contentPublications)
            .set({ status: "failed", updatedAt: new Date() })
            .where(eq(contentPublications.id, publicationId)),
        "publish.markFailed"
      ).catch((markError) =>
        // Best-effort compensation: if even the status flip fails, surface the
        // ORIGINAL adapter error (more actionable) but log the marking failure.
        log.error("Failed to mark publication failed after adapter error", {
          publicationId,
          error: markError instanceof Error ? markError.message : String(markError),
        })
      );
      throw adapterError;
    }

    log.info("Published content", {
      objectId,
      destination: input.destination,
      publishedVersionId,
    });

    // Emit AFTER the commit + adapter side effect, exactly once per successful
    // publish (§27): re-index for retrieval, run connector pushes, notify. Best
    // effort — a bus failure never rolls back the publish. Fire-and-forget (`void`,
    // not `await`): `emit` swallows its own errors, so awaiting only holds the
    // response open for an SNS round-trip (matches the audit-write pattern).
    void contentEvents.emit("content.published", {
      objectId,
      slug: obj.slug,
      versionId: publishedVersionId,
      destination: input.destination,
      actorKind: actorKindOf(req),
      agentLabel: req.kind === "user" ? null : req.agentLabel,
    });

    return { publicationId, publishedVersionId };
  },

  /**
   * Unpublish an object from a destination (Phase 4, §15.3 / §21). Marks the
   * publication `unpublished`, reverts the object to `draft`, then runs the
   * destination adapter's `unpublish` teardown (for the intranet adapter: hide
   * the object's nav item) AFTER the transaction commits — same
   * external-IO-outside-the-tx discipline as `publish`.
   *
   * Permission + existence-masking mirror `publish`: a non-viewable object 404s
   * (never 403, so private ids cannot be enumerated), then `assertCanEdit`. A
   * no-op-safe call when there is no live publication (returns `unpublished:
   * false`) rather than throwing — unpublishing an already-unpublished object is
   * idempotent from the caller's view.
   */
  async unpublish(
    req: Requester,
    objectId: string,
    destination: PublishDestination,
    opts: { hasPublishPublicCapability?: boolean } = {}
  ): Promise<{ unpublished: boolean }> {
    const log = createLogger({ action: "publish.unpublish" });

    const obj = await loadPublishable(objectId);
    if (!obj) {
      throw new NotFoundError("Content not found", { objectId });
    }
    // Mask existence before revealing edit state (404, not 403).
    const viewable = await visibilityService.canView(req, {
      id: objectId,
      ownerUserId: obj.ownerUserId,
      visibilityLevel: obj.visibilityLevel,
    });
    if (!viewable) {
      throw new NotFoundError("Content not found", { objectId });
    }
    assertCanEdit(req, obj.ownerUserId);

    // §26.4 — taking a public destination offline requires the same authority
    // as putting it up in the first place. Without this, `content:publish_internal`
    // alone could tear down already-live public content it could never have
    // published, which is backwards from a review-safety standpoint.
    if (
      destination === "public_web" &&
      !canPublishPublic(req, opts.hasPublishPublicCapability ?? false)
    ) {
      throw new ApprovalRequiredError(
        "Unpublishing from a public destination requires approval",
        { destination, objectId }
      );
    }

    const adapter = adapters[destination];

    // Mark the publication unpublished and revert the object to draft atomically.
    // Lock the row FOR UPDATE so a concurrent publish/unpublish serializes here.
    const externalRef = await executeTransaction(
      async (tx: DbTransaction) => {
        const locked = await tx
          .select({ id: contentObjects.id })
          .from(contentObjects)
          .where(eq(contentObjects.id, objectId))
          .for("update")
          .limit(1);
        if (!locked[0]) {
          throw new NotFoundError("Content not found", { objectId });
        }

        // Find the live publication. No live row → nothing to unpublish; the
        // status revert is skipped and the caller is told `unpublished: false`.
        const pub = await tx
          .select({
            id: contentPublications.id,
            externalRef: contentPublications.externalRef,
          })
          .from(contentPublications)
          .where(
            and(
              eq(contentPublications.objectId, objectId),
              eq(contentPublications.destination, destination),
              eq(contentPublications.status, "live")
            )
          )
          .limit(1);
        if (!pub[0]) return undefined;

        await tx
          .update(contentPublications)
          .set({ status: "unpublished", updatedAt: new Date() })
          .where(eq(contentPublications.id, pub[0].id));

        // Revert the object to draft so it no longer reads as published. Visibility
        // is intentionally NOT narrowed here — unpublishing removes the live
        // surface, not the grant set; a later republish reuses the same visibility.
        await tx
          .update(contentObjects)
          .set({ status: "draft", updatedAt: new Date() })
          .where(eq(contentObjects.id, objectId));

        return pub[0].externalRef;
      },
      "publish.unpublish"
    );

    if (externalRef === undefined) {
      // No live publication existed — idempotent no-op.
      return { unpublished: false };
    }

    // Destination teardown AFTER the transaction commits (external/secondary IO
    // outside the tx). For the intranet adapter this hides the nav item; a
    // failure is logged and surfaced (the publication is already marked
    // unpublished, so the live surface is gone regardless).
    if (adapter.unpublish) {
      try {
        await adapter.unpublish({ objectId, externalRef });
      } catch (adapterError) {
        log.error("Unpublish adapter teardown failed", {
          objectId,
          destination,
          error:
            adapterError instanceof Error
              ? adapterError.message
              : String(adapterError),
        });
        throw adapterError;
      }
    }

    log.info("Unpublished content", { objectId, destination });

    // Emit after the commit + adapter teardown, only when a live publication was
    // actually removed (the `unpublished: false` no-op path returned above).
    // Fire-and-forget (`void`, not `await`): best-effort, never blocks the response.
    void contentEvents.emit("content.unpublished", {
      objectId,
      slug: obj.slug,
      destination,
      actorKind: actorKindOf(req),
      agentLabel: req.kind === "user" ? null : req.agentLabel,
    });

    return { unpublished: true };
  },

  /**
   * The current publication for an object at a destination, or null when it has
   * never been published there.
   */
  async currentPublication(
    objectId: string,
    destination: PublishDestination
  ): Promise<{ id: string; publishedVersionId: string; status: string } | null> {
    const rows = await executeQuery(
      (db) =>
        db
          .select({
            id: contentPublications.id,
            publishedVersionId: contentPublications.publishedVersionId,
            status: contentPublications.status,
          })
          .from(contentPublications)
          .where(
            and(
              eq(contentPublications.objectId, objectId),
              eq(contentPublications.destination, destination)
            )
          )
          .limit(1),
      "publish.currentPublication"
    );
    return rows[0] ?? null;
  },

  /**
   * Resolve a `live` publication by the object's slug at a destination — the
   * lookup the in-app reader (`/c/[slug]`) uses to find which version to serve.
   * Returns null when no object has that slug or it is not live at the
   * destination. Visibility is NOT enforced here: the reader applies `canView`
   * against the resolved object.
   */
  async getPublishedBySlug(
    slug: string,
    destination: PublishDestination
  ): Promise<{ objectId: string; publishedVersionId: string } | null> {
    const rows = await executeQuery(
      (db) =>
        db
          .select({
            objectId: contentObjects.id,
            publishedVersionId: contentPublications.publishedVersionId,
          })
          .from(contentObjects)
          .innerJoin(
            contentPublications,
            eq(contentPublications.objectId, contentObjects.id)
          )
          .where(
            and(
              eq(contentObjects.slug, slug),
              eq(contentPublications.destination, destination),
              eq(contentPublications.status, "live")
            )
          )
          .limit(1),
      "publish.getPublishedBySlug"
    );
    return rows[0] ?? null;
  },
};
