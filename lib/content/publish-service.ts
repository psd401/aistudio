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
 * live*. As of Phase 7 (#1057) two reader-backed adapters are live — `intranet`
 * (`/c/[slug]`) and `public_web` (`/p/[slug]`) — and `schoology` / `google` are
 * governed connector stubs that throw until wired. Every non-intranet destination
 * is public-facing (`isPublicDestination`) and sits behind the §26.4 gate.
 *
 * See docs/features/atrium-design-spec.md §15 (publishing) / §26.4 (public gate).
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
  raisePublishApprovalRequired,
} from "./helpers";
import { visibilityService } from "./visibility-service";
import { versionService } from "./version-service";
import { retrievalService } from "./retrieval-service";
import { contentEvents } from "./events";
import {
  NotFoundError,
  ValidationError,
  VersionPreconditionFailedError,
} from "./errors";
import {
  isPublicDestination,
  type PublishAdapter,
  type PublishDestination,
} from "./publish-adapters/types";
import { intranetAdapter } from "./publish-adapters/intranet";
import { publicWebAdapter } from "./publish-adapters/public-web";
import { schoologyAdapter } from "./publish-adapters/schoology";
import { googleAdapter } from "./publish-adapters/google";
import { okfAdapter } from "./publish-adapters/okf";
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
  /**
   * Publish a SPECIFIC version rather than the object's current head. Used by
   * the §26.4 approval replay (issue #1118): a request pins the raise-time head
   * so approving it publishes the REVIEWED version even if the author has since
   * edited a newer head. The version must belong to the object (validated below,
   * ValidationError otherwise). Omit to publish the current head (the default).
   */
  versionId?: string;
}

/**
 * The destination adapter registry (Phase 7, #1057). Two live, reader-backed
 * destinations — `intranet` (`/c/[slug]`) and `public_web` (`/p/[slug]`) — plus
 * the `schoology` / `google` connector STUBS (`implemented: false`), which are
 * explicit v1 non-goals beyond a governed path (§2). A stub's adapter throws
 * BEFORE the publish transaction (see the `implemented === false` guard below),
 * so a not-yet-wired connector fails loudly rather than committing a publication
 * row with no live side effect. All three non-intranet destinations are
 * public-facing (`isPublicDestination`) and sit behind the §26.4 gate.
 */
const adapters: Record<PublishDestination, PublishAdapter> = {
  intranet: intranetAdapter,
  public_web: publicWebAdapter,
  schoology: schoologyAdapter,
  google: googleAdapter,
  // `okf` serializes a single object to a portable OKF concept bundle (Phase 8,
  // #1103, §36.2). Registered so the destination is pipeline-complete; the primary
  // collection-grained surface is `okfExportService` (export_okf).
  okf: okfAdapter,
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

function assertVersionPrecondition(
  expectedVersionId: string | null | undefined,
  currentVersionId: string | null
): void {
  if (
    expectedVersionId !== undefined &&
    currentVersionId !== expectedVersionId
  ) {
    throw new VersionPreconditionFailedError(
      expectedVersionId,
      currentVersionId
    );
  }
}

async function raiseDestinationPublishApproval(
  txInput: {
    req: Requester;
    objectId: string;
    slug: string;
    destination: PublishDestination;
    publishedVersionId: string;
    wantsPublicWiden: boolean;
  },
  expectedVersionId: string | null | undefined
): Promise<never> {
  const raiseApproval = (): never =>
    raisePublishApprovalRequired(
      txInput.req,
      "Publishing to a public destination requires approval",
      {
        objectId: txInput.objectId,
        slug: txInput.slug,
        destination: txInput.destination,
      },
      {
        destination: txInput.destination,
        objectId: txInput.objectId,
        versionId: txInput.publishedVersionId,
        wantsPublicWiden: txInput.wantsPublicWiden,
      }
    );

  if (expectedVersionId === undefined) return raiseApproval();
  await executeTransaction(
    async (tx: DbTransaction) => {
      const locked = await tx
        .select({
          id: contentObjects.id,
          currentVersionId: contentObjects.currentVersionId,
        })
        .from(contentObjects)
        .where(eq(contentObjects.id, txInput.objectId))
        .for("update")
        .limit(1);
      if (!locked[0]) {
        throw new NotFoundError("Content not found", {
          objectId: txInput.objectId,
        });
      }
      assertVersionPrecondition(
        expectedVersionId,
        locked[0].currentVersionId
      );
      return raiseApproval();
    },
    "publish.queueApprovalWithVersionPrecondition"
  );
  return raiseApproval();
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

/**
 * Resolve which version a publish will make live: the caller's pinned
 * `input.versionId` (an approval replay of the raise-time head — issue #1118), or
 * the object's current working head. A pinned version MUST belong to the object
 * (an approval row could name a version of a different object only via corruption)
 * — `versionService.getById` scopes by object and returns null otherwise, which
 * we map to a ValidationError. A null head (no version) is "nothing to publish".
 * Runs OUTSIDE the transaction (a plain read), before the §26.4 gate.
 */
async function resolvePublishVersionId(
  objectId: string,
  obj: PublishableObject,
  input: PublishInput
): Promise<string> {
  if (input.versionId != null) {
    const version = await versionService.getById(objectId, input.versionId);
    if (!version) {
      throw new ValidationError("Version not found for this object", {
        objectId,
        versionId: input.versionId,
      });
    }
    return input.versionId;
  }
  if (obj.currentVersionId == null) {
    throw new ValidationError("Nothing to publish", { objectId });
  }
  return obj.currentVersionId;
}

/**
 * Post-commit publish side effects, both best-effort: a successful publish has
 * already committed, so neither a retrieval-index failure nor an event-bus
 * hiccup may roll it back. Extracted from `publish` so the method stays within
 * the length budget; the sequencing is unchanged — the retrieval index (§16.1)
 * is awaited so indexing happens inline on the publish path (its failure is
 * caught + logged, NOT an invariant — a later re-publish/re-index retries it),
 * then the `content.published` event (§27: connector pushes, notifications) is
 * emitted fire-and-forget (`void`), since `emit` swallows its own errors and
 * awaiting would only hold the response open for an SNS round-trip.
 */
async function runPublishSideEffects(args: {
  req: Requester;
  objectId: string;
  slug: string;
  publishedVersionId: string;
  destination: PublishDestination;
  log: ReturnType<typeof createLogger>;
}): Promise<void> {
  const { req, objectId, slug, publishedVersionId, destination, log } = args;
  try {
    // Index the version we just made LIVE, not the object's head — a §26.4
    // approval replay can publish an OLDER pinned version while the author has a
    // newer head (issue #1118); indexing the head would leak the unreviewed head
    // text to assistant retrieval while readers serve the reviewed version.
    await retrievalService.indexObject(objectId, publishedVersionId);
  } catch (indexError) {
    log.warn("Failed to index published content for retrieval", {
      objectId,
      error:
        indexError instanceof Error ? indexError.message : String(indexError),
    });
  }

  void contentEvents.emit("content.published", {
    objectId,
    slug,
    versionId: publishedVersionId,
    destination,
    actorKind: actorKindOf(req),
    agentLabel: req.kind === "user" ? null : req.agentLabel,
  });
}

/**
 * Post-commit destination side effect + external-ref recording (Phase 7, #1057).
 * Extracted from `publish` so the method stays within the max-lines budget; the
 * sequencing is unchanged.
 *
 * The publication row was already committed as `status: "live"`. This runs the
 * destination adapter AFTER the transaction (external IO inside a tx is a
 * drizzle-client anti-pattern) with two guarantees:
 *  1. Compensation: if the adapter throws — a real external adapter (Schoology/
 *     Google) failing to notify the destination, OR the `intranet` adapter's
 *     post-commit nav-item write (`ensureNavItem`) failing — flip the row to
 *     `failed` so a retry re-runs the adapter, and re-throw so the caller sees the
 *     failure. `public_web` DOES run here, but only computes a URL string (no
 *     I/O), so it never throws and thus never reaches this compensation branch;
 *     the Schoology/Google stubs throw BEFORE the tx and so never reach
 *     `runPublishAdapter` at all.
 *  2. External-ref recording: persist the adapter's returned `external_ref` (the
 *     `public_web` reader URL, a future connector resource id, …) so the row
 *     records WHERE the version went live. Skipped when the adapter has no
 *     external system (intranet returns null). Best-effort: the content is
 *     already live, so a failure to record the descriptive ref is logged, not
 *     thrown (it never un-publishes live content); republish overwrites it via
 *     this same UPDATE, so a stale ref cannot linger.
 */
async function runPublishAdapter(args: {
  adapter: PublishAdapter;
  objectId: string;
  slug: string;
  versionId: string;
  title: string;
  collectionId: string | null;
  publicationId: string;
  destination: PublishDestination;
  log: ReturnType<typeof createLogger>;
}): Promise<void> {
  const {
    adapter,
    objectId,
    slug,
    versionId,
    title,
    collectionId,
    publicationId,
    destination,
    log,
  } = args;

  let externalRef: string | null = null;
  try {
    const adapterResult = await adapter.publish({
      objectId,
      slug,
      versionId,
      title,
      collectionId,
    });
    externalRef = adapterResult.externalRef;
  } catch (adapterError) {
    log.error("Publish adapter failed; marking publication failed", {
      objectId,
      destination,
      publicationId,
      error:
        adapterError instanceof Error ? adapterError.message : String(adapterError),
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

  if (externalRef !== null) {
    await executeQuery(
      (db) =>
        db
          .update(contentPublications)
          .set({ externalRef, updatedAt: new Date() })
          .where(eq(contentPublications.id, publicationId)),
      "publish.persistExternalRef"
    ).catch((refError) =>
      log.warn("Failed to persist publication external_ref", {
        publicationId,
        destination,
        error: refError instanceof Error ? refError.message : String(refError),
      })
    );
  }
}

// §26.4 — this publish path's two gate sites (the pre-tx public-destination branch
// and the in-tx visibility-widen branch, below) both raise via the shared
// `raisePublishApprovalRequired` (in `./helpers`, also used by
// `visibilityService.setLevel`) so the message + emitted event shape stay
// identical across every §26.4 gate site.

/**
 * §26.4 — taking a public-facing destination (public_web/schoology/google) offline
 * requires the same authority as putting it up. Without this, `content:publish_internal`
 * alone could tear down already-live public content it could never have published,
 * which is backwards from a review-safety standpoint. Routes through the shared raise
 * (issue #1118 item 2) so a blocked unpublish PERSISTS a durable
 * `content_publish_requests` row (kind `unpublish`, replayed cleanly via `unpublish`
 * on approve) and appears in /admin/atrium — previously this was a raw throw that
 * queued nothing. The caller only invokes this once a live publication is confirmed,
 * so an already-offline destination is never gated or queued. `never`-typed when it
 * raises; a no-op when the destination is internal or the caller is authorized. Safe
 * pre-tx (no lock held), so no deadlock concern.
 */
function assertMayUnpublishPublicOrRaise(
  req: Requester,
  obj: PublishableObject,
  objectId: string,
  destination: PublishDestination,
  opts: { hasPublishPublicCapability?: boolean }
): void {
  if (
    isPublicDestination(destination) &&
    !canPublishPublic(req, opts.hasPublishPublicCapability ?? false)
  ) {
    raisePublishApprovalRequired(
      req,
      "Unpublishing from a public destination requires approval",
      { objectId, slug: obj.slug, destination },
      { destination, objectId, requestKind: "unpublish" }
    );
  }
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
    opts: {
      hasPublishPublicCapability?: boolean;
      expectedVersionId?: string | null;
    } = {}
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

    // Fast preflight for normal API callers. Approval replays omit this option
    // because their explicit input.versionId intentionally pins an older,
    // reviewed version.
    assertVersionPrecondition(
      opts.expectedVersionId,
      obj.currentVersionId
    );

    // Whether this caller holds the §26.4 public-publish authority (pure, no IO).
    const mayPublishPublic = canPublishPublic(
      req,
      opts.hasPublishPublicCapability ?? false
    );

    const adapter = adapters[input.destination];

    // Resolve the version to publish (the current head, or the specific version an
    // approval replay pinned — issue #1118). This CHEAP business validation runs
    // BEFORE the §26.4 gate (issue #1118 item 6): a request that can never
    // succeed — nothing to publish (null head), or a pinned version that does not
    // belong to the object — must fail with a plain ValidationError instead of
    // being persisted to the approval queue as a doomed row that just re-hits the
    // same error on approve. It leaks nothing the caller (already past
    // `assertCanEdit`) doesn't know. The §26.4 authorization ORDER is unchanged
    // (canView → assertCanEdit → gate); only this validation moved ahead of it.
    const publishedVersionId = await resolvePublishVersionId(objectId, obj, input);

    // A destination whose adapter is not yet implemented (schoology/google — later
    // phases) must fail BEFORE any write, and — issue #1118 item 6 — BEFORE the
    // §26.4 gate so an unauthorized schoology/google publish (doomed: the adapter
    // throws on approve too) is not queued. The revealed fact ("destination not
    // yet wired") is static and non-sensitive. Otherwise the status/visibility
    // widening below would commit, the post-commit adapter call would throw, and
    // the object would be left flagged `public` with no live publication — a
    // "failed" publish that silently exposed content.
    if (adapter.implemented === false) {
      throw new ValidationError(
        `Publishing to '${input.destination}' is not yet available`,
        { destination: input.destination }
      );
    }

    // §26.4 gate — PART 1 (destination), evaluated pre-transaction because it does
    // NOT depend on the object's current visibility (a public-facing destination —
    // public_web/schoology/google, `isPublicDestination` — is ALWAYS a public
    // exposure) and so is race-free here. PART 2 — widening visibility to `public`
    // — DOES depend on the current level, so it is evaluated inside the transaction
    // against the FOR-UPDATE-locked row (see below), closing the TOCTOU hole where
    // a concurrent narrow (public → internal) between a pre-read and the locked
    // write would skip the gate on a real widen-back.
    if (isPublicDestination(input.destination) && !mayPublishPublic) {
      // If the caller supplied If-Match, make the approval decision against a
      // locked head too. Otherwise a version could advance after preflight but
      // before the durable request is raised.
      await raiseDestinationPublishApproval(
        {
          req,
          destination: input.destination,
          objectId,
          slug: obj.slug,
          publishedVersionId,
          wantsPublicWiden: input.visibility?.level === "public",
        },
        opts.expectedVersionId
      );
    }

    // The actor recording the publish. Guests/autonomous agents have no user id;
    // `published_by` is nullable, so a null here is persisted as "system".
    const publishedBy = authorUserIdOf(req);

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
          .select({
            id: contentObjects.id,
            visibilityLevel: contentObjects.visibilityLevel,
            currentVersionId: contentObjects.currentVersionId,
          })
          .from(contentObjects)
          .where(eq(contentObjects.id, objectId))
          .for("update")
          .limit(1);
        if (!locked[0]) {
          throw new NotFoundError("Content not found", { objectId });
        }
        assertVersionPrecondition(
          opts.expectedVersionId,
          locked[0].currentVersionId
        );

        // §26.4 gate — PART 2 (visibility widen), evaluated HERE against the locked
        // row's CURRENT visibility so it is race-free: a widen to `public` is gated
        // iff the locked row is not ALREADY public. A concurrent narrow can no
        // longer slip between the check and the widen (both hold this lock), so an
        // unauthorized caller can never widen-back-to-public un-approved. A no-op
        // re-save of already-public content is not a new exposure and passes.
        // Throwing here rolls the transaction back, so nothing is widened/published.
        if (
          input.visibility?.level === "public" &&
          locked[0].visibilityLevel !== "public" &&
          !mayPublishPublic
        ) {
          raisePublishApprovalRequired(
            req,
            "Publishing to a public destination requires approval",
            { objectId, slug: obj.slug, destination: input.destination },
            {
              destination: input.destination,
              objectId,
              // Pin the raise-time head for the replay (#1118 item 1); the widen
              // is recorded automatically (this branch fires only for a non-public
              // destination bundling a public widen).
              versionId: publishedVersionId,
            }
          );
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

    // Post-commit: run the destination adapter (external IO outside the tx) with
    // compensation, then record its external_ref. Extracted so `publish` stays
    // within the max-lines budget.
    await runPublishAdapter({
      adapter,
      objectId,
      slug: obj.slug,
      versionId: publishedVersionId,
      title: obj.title,
      collectionId: obj.collectionId,
      publicationId,
      destination: input.destination,
      log,
    });

    log.info("Published content", {
      objectId,
      destination: input.destination,
      publishedVersionId,
    });

    // After-commit side effects (retrieval index §16.1 + `content.published`
    // event §27), both best-effort so neither can roll back the committed publish.
    await runPublishSideEffects({
      req,
      objectId,
      slug: obj.slug,
      publishedVersionId,
      destination: input.destination,
      log,
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
   *
   * Once NO destination remains live, the retrieval index entry is pruned
   * post-commit (best-effort) so unpublished content stops surfacing as
   * assistant context (§16); while any other destination is still live the
   * index is kept.
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

    // Idempotent no-op check BEFORE the §26.4 gate (issue #1118 review, P2): if
    // nothing is LIVE at this destination there is nothing to take offline and no
    // public exposure to gate — return the documented `{ unpublished: false }`
    // rather than throwing ApprovalRequiredError and queuing an approval whose
    // replay would only re-run the same no-op. This read leaks nothing (the caller
    // already passed assertCanEdit) and mirrors item 6's "don't queue doomed
    // requests" discipline. Read outside the tx (no lock); the transaction below
    // re-checks the live row under FOR UPDATE, so a concurrent publish landing
    // between this read and the tx is still handled correctly there.
    const liveNow = await executeQuery(
      (db) =>
        db
          .select({ id: contentPublications.id })
          .from(contentPublications)
          .where(
            and(
              eq(contentPublications.objectId, objectId),
              eq(contentPublications.destination, destination),
              eq(contentPublications.status, "live")
            )
          )
          .limit(1),
      "publish.unpublish.liveCheck"
    );
    if (!liveNow[0]) {
      return { unpublished: false };
    }

    // §26.4 gate (only reached when a live publication actually exists — see the
    // no-op check above, so an already-offline destination is never gated/queued).
    assertMayUnpublishPublicOrRaise(req, obj, objectId, destination, opts);

    const adapter = adapters[destination];

    // Mark the publication unpublished and revert the object to draft atomically.
    // Lock the row FOR UPDATE so a concurrent publish/unpublish serializes here.
    // Resolves to undefined when nothing was live (idempotent no-op), else the
    // removed publication's externalRef plus whether ANY other destination is
    // still live (drives the retrieval-index pruning below).
    const outcome = await executeTransaction(
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

        // Revert the object to draft ONLY when no OTHER destination is still live.
        // With `public_web` now a live adapter (Phase 7, #1057), an object can be
        // live on several destinations at once (e.g. `intranet` + `public_web`);
        // unpublishing one destination must NOT mark the object a draft while
        // another reader route still serves it. The row just flipped to
        // `unpublished` above is excluded by the `status = 'live'` filter.
        // Visibility is intentionally NOT narrowed here — unpublishing removes the
        // live surface, not the grant set; a later republish reuses the same
        // visibility.
        const stillLive = await tx
          .select({ id: contentPublications.id })
          .from(contentPublications)
          .where(
            and(
              eq(contentPublications.objectId, objectId),
              eq(contentPublications.status, "live")
            )
          )
          .limit(1);
        if (!stillLive[0]) {
          await tx
            .update(contentObjects)
            .set({ status: "draft", updatedAt: new Date() })
            .where(eq(contentObjects.id, objectId));
        }

        return {
          externalRef: pub[0].externalRef,
          anyLiveRemaining: Boolean(stillLive[0]),
        };
      },
      "publish.unpublish"
    );

    if (outcome === undefined) {
      // No live publication existed — idempotent no-op.
      return { unpublished: false };
    }
    const { externalRef, anyLiveRemaining } = outcome;

    // Retrieval-index pruning (§16) FIRST — before the adapter teardown. Once NO
    // destination is live anywhere, the object must stop surfacing as assistant
    // context: remove its backing repository_item/chunks/link and clear
    // indexed_at. This runs BEFORE the teardown deliberately: the teardown can
    // throw (and re-throws below), and a retry would idempotently no-op at the
    // `status = 'live'` filter and never reach a prune placed after it — leaving
    // the index un-pruned indefinitely. Best-effort itself: the unpublish tx has
    // already committed, so a prune failure is logged, never thrown.
    if (!anyLiveRemaining) {
      try {
        await retrievalService.removeFromIndex(objectId);
      } catch (pruneError) {
        log.warn("Failed to prune retrieval index after unpublish", {
          objectId,
          destination,
          error:
            pruneError instanceof Error ? pruneError.message : String(pruneError),
        });
      }
    }

    // Destination teardown AFTER the transaction commits (external/secondary IO
    // outside the tx). For the intranet adapter this hides the nav item; a
    // failure is logged and surfaced (the publication is already marked
    // unpublished + the index already pruned, so the live surface is gone
    // regardless).
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
   * Take an object OFFLINE at every destination — the takedown cascade for a
   * status transition OUT of `published` (`draft` or `archived`) via
   * `contentService.update` (#1059).
   *
   * This is a removal, so unlike `unpublish` it is NOT §26.4-gated: pulling public
   * content DOWN is always the safe direction, and the caller has already run
   * `assertCanEdit`. It flips every live `content_publications` row for the object
   * to `unpublished` in one FOR-UPDATE-locked transaction, then runs each
   * destination adapter's teardown (e.g. the intranet nav-item hide) post-commit.
   *
   * Without this, setting a published object to `draft` or `archived` left it
   * reachable at its permanent public/intranet reader URL — both readers gate ONLY
   * on a live publication, never on `content_objects.status` — a content-exposure
   * footgun that contradicts what "draft"/"archived" imply. The caller writes the
   * new status; this method never touches status. Idempotent: no live publication
   * (already unpublished, or never published) → no-op.
   */
  async retractAllPublications(objectId: string): Promise<void> {
    const log = createLogger({ action: "publish.retractAllPublications" });

    const torn = await executeTransaction(
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
        const live = await tx
          .select({
            destination: contentPublications.destination,
            externalRef: contentPublications.externalRef,
          })
          .from(contentPublications)
          .where(
            and(
              eq(contentPublications.objectId, objectId),
              eq(contentPublications.status, "live")
            )
          );
        if (live.length === 0) return [];
        await tx
          .update(contentPublications)
          .set({ status: "unpublished", updatedAt: new Date() })
          .where(
            and(
              eq(contentPublications.objectId, objectId),
              eq(contentPublications.status, "live")
            )
          );
        return live;
      },
      "publish.retractAllPublications"
    );

    // Adapter teardown AFTER the commit (secondary IO). Best-effort PER
    // destination: the publication is already flipped `unpublished`, so the live
    // reader surface is gone regardless of a nav-hide failure — log and continue
    // so one failing destination cannot leave the others' teardown unrun.
    for (const pub of torn) {
      const adapter = adapters[pub.destination as PublishDestination];
      if (!adapter?.unpublish) continue;
      try {
        await adapter.unpublish({ objectId, externalRef: pub.externalRef });
      } catch (adapterError) {
        log.warn("Archive teardown failed for a destination", {
          objectId,
          destination: pub.destination,
          error:
            adapterError instanceof Error
              ? adapterError.message
              : String(adapterError),
        });
      }
    }
    if (torn.length > 0) {
      log.info("Retracted all live publications for archive", {
        objectId,
        destinations: torn.map((p) => p.destination),
      });
    }
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
   * The destinations at which an object is currently LIVE (status = 'live'), in no
   * particular order. Empty when the object is published nowhere.
   *
   * Read-only, no lock — a fast pre-check for the hard-delete guard ("unpublish
   * everywhere first") and the UI's disabled-Delete state. The AUTHORITATIVE
   * delete guard re-checks the same condition on the FOR-UPDATE-locked object row
   * inside the delete transaction, so this racy read is only an early rejection /
   * a UI hint, never the security boundary.
   */
  async liveDestinations(objectId: string): Promise<PublishDestination[]> {
    const rows = await executeQuery(
      (db) =>
        db
          .select({ destination: contentPublications.destination })
          .from(contentPublications)
          .where(
            and(
              eq(contentPublications.objectId, objectId),
              eq(contentPublications.status, "live")
            )
          ),
      "publish.liveDestinations"
    );
    return rows.map((r) => r.destination as PublishDestination);
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
