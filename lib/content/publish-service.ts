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
import { assertCanEdit, authorUserIdOf } from "./helpers";
import { visibilityService } from "./visibility-service";
import { NotFoundError, ValidationError, ForbiddenError } from "./errors";
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
    input: PublishInput
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

    // Public web publishing (and the approval/capability gate it requires per
    // §26.4) lands in a later phase. The Phase 1 reference path only needs
    // `intranet`, so reject `public_web` explicitly rather than half-wiring it.
    if (input.destination === "public_web") {
      throw new ForbiddenError(
        "Publishing to the public web is not available yet",
        { destination: input.destination }
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

    const publicationId = await executeTransaction(
      async (tx: DbTransaction) => {
        // Optional visibility widening: replace grants (for group) and set the
        // object's level + mark it published. Done inside the tx so the
        // publication and the visibility it implies commit atomically.
        if (input.visibility) {
          if (input.visibility.level === "group") {
            await visibilityService.applyGrants(
              tx,
              objectId,
              input.visibility.grants ?? []
            );
          }
          await tx
            .update(contentObjects)
            .set({
              visibilityLevel: input.visibility.level,
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
    await adapter.publish({
      objectId,
      slug: obj.slug,
      versionId: publishedVersionId,
    });

    log.info("Published content", {
      objectId,
      destination: input.destination,
      publishedVersionId,
    });
    return { publicationId, publishedVersionId };
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
