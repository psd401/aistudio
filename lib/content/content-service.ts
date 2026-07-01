/**
 * Atrium content service
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). The single write path for content
 * objects — create / get / list / update. Every surface (server actions, REST v1,
 * MCP) calls this; there is no UI-only creation path.
 *
 * See docs/features/atrium-design-spec.md §11.2.
 *
 * All DB access goes through `executeQuery` / `executeTransaction` (postgres.js
 * driver); JSONB columns insert via `sql\`${safeJsonbStringify(v)}::jsonb\``.
 */

import { eq, like, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import { contentCollections, contentObjects } from "@/lib/db/schema";
import { safeJsonbStringify } from "@/lib/db/json-utils";
import {
  actorKindOf,
  agentIdOf,
  assertCanCreate,
  assertCanEdit,
  canPublishPublic,
  slugCandidate,
  slugifyTitle,
  systemUserId,
} from "./helpers";
import {
  objectSelectFields,
  rowToObjectDTO,
  type ObjectRowAsText,
} from "./mappers";
import { snapshotInTx, versionService } from "./version-service";
import { visibilityService } from "./visibility-service";
import {
  ApprovalRequiredError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./errors";
import type {
  ContentObjectDTO,
  ContentObjectWithVersion,
  CreateObjectInput,
  ListFilter,
  Requester,
  SnapshotInput,
  UpdatePatch,
  VisibilityLevel,
} from "./types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Max title length, matching the `content_objects.title varchar(500)` column. */
const TITLE_MAX_LENGTH = 500;

/** Postgres unique-violation (SQLSTATE 23505) detector for typed-error mapping. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

/**
 * Allocate a unique slug for a title within the create transaction.
 *
 * Fetches all slugs that collide with the base (`base` and `base-N`) in a single
 * query, then picks the first free candidate in memory — avoiding the previous
 * sequential per-candidate round-trips while the transaction held a pooled
 * connection. Scanning is bounded by `taken.size + 1`: among that many distinct
 * candidates at least one must be free, so no fixed low ceiling can spuriously
 * reject a bulk import of similarly-titled documents. The final guard is the
 * `content_objects.slug` unique constraint, whose violation the INSERT's
 * `isUniqueViolation` catch translates into a `ConflictError` on the rare
 * concurrent-create race.
 */
async function uniqueSlug(tx: DbTransaction, title: string): Promise<string> {
  const base = slugifyTitle(title);
  // `_` and `%` are not producible by slugifyTitle (it emits [a-z0-9-] only), so
  // no LIKE-wildcard escaping is required for the base prefix.
  //
  // Match only the actual collision candidates — the bare `base` and the
  // suffixed `base-1`, `base-2`, … forms produced by `slugCandidate`. A bare
  // `LIKE base%` over-fetches unrelated neighbours (`report` would pull in
  // `reporter`, `report-card`, `reporting-2024`), loading rows we never compare
  // against while the transaction holds a pooled connection.
  const taken = new Set(
    (
      await tx
        .select({ slug: contentObjects.slug })
        .from(contentObjects)
        .where(
          sql`${contentObjects.slug} = ${base} OR ${like(
            contentObjects.slug,
            `${base}-%`
          )}`
        )
    ).map((r) => r.slug)
  );
  // `taken.size + 1` distinct candidates guarantees at least one free slot.
  const maxAttempts = taken.size + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = slugCandidate(base, attempt);
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable given the bound above; kept as a defensive guard.
  throw new ConflictError("Could not allocate a unique slug", { base });
}

/**
 * Resolve a collection's default visibility level, or null if no collection.
 * Runs OUTSIDE the create transaction so `create()` can run its §26.4
 * public-publish gate check before opening the transaction — mirroring
 * `publishService.publish`, which resolves + gates entirely outside its
 * transaction (never holds a pooled connection across an authorization
 * decision that might itself branch into other I/O).
 */
async function collectionDefaultOutsideTx(
  collectionId: string | undefined
): Promise<VisibilityLevel | null> {
  if (!collectionId) return null;
  const rows = await executeQuery(
    (db) =>
      db
        .select({ level: contentCollections.defaultVisibilityLevel })
        .from(contentCollections)
        .where(eq(contentCollections.id, collectionId))
        .limit(1),
    "content.create.collectionDefault"
  );
  if (!rows[0]) {
    throw new ValidationError("Collection not found", { collectionId });
  }
  return rows[0].level as VisibilityLevel;
}

/**
 * Validate that a collection exists, throwing a typed `ValidationError` (400) on
 * miss. Used by `update()` — which (unlike `create()`) does not call
 * `collectionDefault` — so an invalid `collectionId` surfaces as a user-facing
 * 400 rather than a raw Postgres FK violation (SQLSTATE 23503).
 */
async function assertCollectionExists(collectionId: string): Promise<void> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ id: contentCollections.id })
        .from(contentCollections)
        .where(eq(contentCollections.id, collectionId))
        .limit(1),
    "content.assertCollectionExists"
  );
  if (!rows[0]) {
    throw new ValidationError("Collection not found", { collectionId });
  }
}

/**
 * Load an object by id (UUID) or slug. Returns the DTO or null.
 *
 * A UUID-shaped input is tried as an id first; if no row matches it falls back to
 * a slug lookup. This keeps an object reachable by slug even in the (unusual)
 * case where its slug is itself UUID-shaped — `slugifyTitle` can emit such a slug
 * for an all-hex/hyphen title.
 */
async function loadByIdOrSlug(
  idOrSlug: string
): Promise<ContentObjectDTO | null> {
  const lookup = (where: ReturnType<typeof eq>) =>
    executeQuery(
      (db) =>
        db.select(objectSelectFields).from(contentObjects).where(where).limit(1),
      "content.loadByIdOrSlug"
    );

  if (UUID_RE.test(idOrSlug)) {
    const byId = await lookup(eq(contentObjects.id, idOrSlug));
    if (byId[0]) return rowToObjectDTO(byId[0] as ObjectRowAsText);
    // Fall through to slug: the input is UUID-shaped but matches no id.
  }
  const bySlug = await lookup(eq(contentObjects.slug, idOrSlug));
  return bySlug[0] ? rowToObjectDTO(bySlug[0] as ObjectRowAsText) : null;
}

export const contentService = {
  loadByIdOrSlug,

  /**
   * Create a content object. When `input.body` is supplied, an initial version
   * (v1) is snapshotted in the same transaction and becomes the object's head.
   */
  async create(
    req: Requester,
    input: CreateObjectInput,
    opts: { hasPublishPublicCapability?: boolean } = {}
  ): Promise<ContentObjectWithVersion> {
    assertCanCreate(req);

    if (!input.title?.trim()) {
      throw new ValidationError("Title is required");
    }
    // Enforce the varchar(500) column limit as a typed 400 rather than a raw
    // Postgres 22001 ("value too long") error.
    if (input.title.trim().length > TITLE_MAX_LENGTH) {
      throw new ValidationError(
        `Title must be ${TITLE_MAX_LENGTH} characters or fewer`
      );
    }
    if (input.kind !== "document" && input.kind !== "artifact") {
      throw new ValidationError("kind must be 'document' or 'artifact'", {
        kind: input.kind,
      });
    }

    const ownerUserId = ownerFor(req);
    // Use the shared resolvers so object-level provenance matches version-level
    // (snapshotInTx uses the same helpers): actor === 'agent' iff an agent id is
    // recorded (autonomous only); delegated agents record as 'human'.
    const createdByActor = actorKindOf(req);
    const createdByAgentId = agentIdOf(req);

    // A group object with no grants is invisible to everyone but the owner/admin
    // (equivalent to private without the semantics) — almost always a mistake.
    // The authoritative enforcement is `applyGrantsForLevel` below (against the
    // RESOLVED level, so a collection-defaulted `group` is covered too); this is a
    // cheap pre-transaction fast-fail for the common explicit-group case.
    if (
      input.visibility?.level === "group" &&
      (input.visibility.grants?.length ?? 0) === 0
    ) {
      throw new ValidationError(
        "group visibility requires at least one grant"
      );
    }

    const grants = input.visibility?.grants ?? [];
    let visibilityLevel: VisibilityLevel =
      input.visibility?.level ??
      (await collectionDefaultOutsideTx(input.collectionId)) ??
      "private";

    // A collection whose default is `group` can't be satisfied at create time:
    // the create surface (library "New doc/artifact", the dialog takes only a
    // title) authors no grants, and a grantless `group` is invisible to all but
    // owner/admin. Rather than BLOCK creation from a group-default section
    // (every seeded group collection would 400), fall back to `private`
    // (owner-only) when the level was INHERITED from the collection default and
    // no grants were supplied; the author then sets group visibility + grants
    // via the Phase 3 visibility editor. An EXPLICIT grantless group still
    // fails (the pre-transaction guard above + the assert below) — only the
    // silent collection-default inheritance is softened here.
    if (
      input.visibility?.level == null &&
      visibilityLevel === "group" &&
      grants.length === 0
    ) {
      visibilityLevel = "private";
    }

    // Validate the RESOLVED level + grants BEFORE the transaction so an invalid
    // combination (e.g. an explicit `group` with no grants) fails without
    // writing — and rolling back — an object row. The pre-transaction guard
    // above only catches the explicit-`group` case.
    visibilityService.assertWritableLevel(visibilityLevel, grants);

    // §26.4 — creating directly at `public` (explicitly, or via a collection
    // whose admin-set default is `public`) is the same privilege boundary as
    // widening to public through `publish`/`set_visibility`; gate it the same
    // way rather than letting a `content:create`-only caller reach "public"
    // by skipping straight to creation.
    if (
      visibilityLevel === "public" &&
      !canPublishPublic(req, opts.hasPublishPublicCapability ?? false)
    ) {
      // No object exists yet to carry an id/slug on the approval-queue event
      // (unlike `publish`/`setLevel`, which gate an already-persisted object) —
      // surface the same structured error; the surface layer's audit write
      // still records the attempted (denied) create.
      throw new ApprovalRequiredError(
        "Creating public content requires approval",
        { title: input.title }
      );
    }

    const { object, version, s3Writes } = await executeTransaction(
      async (tx) => {
        const slug = await uniqueSlug(tx, input.title);

        // Translate a slug unique-violation that slips past uniqueSlug (a
        // concurrent create racing the SELECT) into a typed ConflictError.
        const inserted = await tx
          .insert(contentObjects)
          .values({
            kind: input.kind,
            title: input.title,
            slug,
            ownerUserId,
            createdByActor,
            createdByAgentId,
            collectionId: input.collectionId ?? null,
            visibilityLevel,
            status: "draft",
            // Typed JSONB must use the postgres.js cast pattern.
            sourceRef: sql`${safeJsonbStringify(
              input.sourceRef ?? { type: "none" }
            )}::jsonb`,
            tags: input.tags ?? [],
          })
          .returning(objectSelectFields)
          .catch((e: unknown) => {
            if (isUniqueViolation(e)) {
              throw new ConflictError("A content object with this slug already exists", {
                slug,
              });
            }
            throw e;
          });

        const row = inserted[0];
        if (!row) {
          throw new ConflictError("Failed to create content object", { slug });
        }

        // Reconcile grants against the RESOLVED level (enforces group-≥1-grant
        // even when the level came from the collection default, and the
        // non-group / private rules) — the same invariant `setLevelInTx` applies.
        await visibilityService.applyGrantsForLevel(
          tx,
          row.id,
          visibilityLevel,
          grants
        );

        const dto = rowToObjectDTO(row as ObjectRowAsText);

        if (input.body !== undefined) {
          const snap = await snapshotInTx(
            tx,
            req,
            { id: dto.id, kind: input.kind },
            { body: input.body, bodyFormat: input.bodyFormat }
          );
          // Reflect the new head id without a re-select.
          dto.currentVersionId = snap.version.id;
          return { object: dto, version: snap.version, s3Writes: snap.s3Writes };
        }
        return { object: dto, version: null, s3Writes: [] };
      },
      "content.create"
    );

    // S3 IO happens AFTER the transaction commits (never inside it).
    await versionService.flushSnapshotWrites(s3Writes);

    return { ...object, version };
  },

  /**
   * Snapshot a new version of an existing object, enforcing edit permission.
   * Body changes always flow through here (never through `update`). Returns the
   * object with its new head version.
   */
  async createVersion(
    req: Requester,
    id: string,
    input: SnapshotInput
  ): Promise<ContentObjectWithVersion> {
    const obj = await loadByIdOrSlug(id);
    if (!obj) throw new NotFoundError("Content not found", { id });
    // Mask existence from callers who cannot view it before revealing edit state.
    await assertViewable(req, obj, id);
    assertCanEdit(req, obj.ownerUserId);

    // The version-number allocation (`MAX(version_number) + 1`) is intentionally
    // race-prone and the unique constraint maps a loser to ConflictError (409).
    // Back-to-back writers (e.g. an autosave firing twice) would otherwise surface
    // an unrecoverable error toast. A single transparent retry re-reads the head
    // version and almost always wins the second time; a still-conflicting second
    // attempt (sustained contention) re-throws so the caller can decide.
    let version: Awaited<ReturnType<typeof versionService.snapshot>>;
    try {
      version = await versionService.snapshot(
        req,
        { id: obj.id, kind: obj.kind },
        input
      );
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      version = await versionService.snapshot(
        req,
        { id: obj.id, kind: obj.kind },
        input
      );
    }
    // Re-load so the returned object carries the post-snapshot updatedAt and
    // currentVersionId (snapshotInTx advances both); returning the pre-snapshot
    // `obj` would hand callers a stale updatedAt for cache/optimistic-lock use.
    const refreshed = await loadByIdOrSlug(obj.id);
    if (!refreshed) {
      // The object was concurrently deleted between the snapshot commit and this
      // reload. Falling back to the pre-snapshot `obj` would hand callers a stale
      // `updatedAt`, silently corrupting any optimistic-lock or cache-invalidation
      // consumer. Surface the deletion instead so the caller can react.
      throw new NotFoundError("Content not found", { id: obj.id });
    }
    return { ...refreshed, currentVersionId: version.id, version };
  },

  /**
   * Load an object (with its current version) by id or slug, enforcing `canView`.
   * Throws NotFoundError if missing, ForbiddenError if not viewable.
   */
  async get(
    req: Requester,
    idOrSlug: string
  ): Promise<ContentObjectWithVersion> {
    const obj = await loadByIdOrSlug(idOrSlug);
    if (!obj) throw new NotFoundError("Content not found", { idOrSlug });

    // 404 (not 403) on a non-viewable object to avoid leaking existence.
    await assertViewable(req, obj, idOrSlug);

    const version = obj.currentVersionId
      ? await versionService.current(obj.id)
      : null;
    return { ...obj, version };
  },

  /** Permission-pushed list of objects visible to the requester. */
  async list(req: Requester, filter: ListFilter = {}): Promise<ContentObjectDTO[]> {
    return visibilityService.listVisible(req, filter);
  },

  /**
   * Metadata-only patch (title, tags, collection, status). Body changes go
   * through `versionService.snapshot`. Clearable fields use `?? null` so an
   * explicit clear is persisted (never `undefined` in `.set()`).
   *
   * NOT dead code: Phase 0 ships no server action for this (the PR exposes only
   * create/get/list/create-version). It is invoked by the Phase 1 update action
   * and the Phase 5 `PATCH /api/v1/content/:id` endpoint. Keep it.
   */
  async update(
    req: Requester,
    id: string,
    patch: UpdatePatch
  ): Promise<ContentObjectDTO> {
    const existing = await loadByIdOrSlug(id);
    if (!existing) throw new NotFoundError("Content not found", { id });
    await assertViewable(req, existing, id);
    assertCanEdit(req, existing.ownerUserId);

    // Typed against the table's insert shape so a column-name typo is a compile
    // error (a `Record<string, unknown>` would silently no-op an unknown key).
    const setValues: Partial<typeof contentObjects.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new ValidationError("Title cannot be empty");
      // Mirror create()'s varchar(500) guard so an over-long title is a typed
      // 400, not a raw Postgres 22001 error.
      if (patch.title.trim().length > TITLE_MAX_LENGTH) {
        throw new ValidationError(
          `Title must be ${TITLE_MAX_LENGTH} characters or fewer`
        );
      }
      setValues.title = patch.title;
    }
    // Coerce to `[]` (never NULL) so updated rows match the `create()` invariant
    // (tags is always an array). Downstream `.length`/`.filter()` callers would
    // otherwise throw a TypeError on a null tags column.
    if (patch.tags !== undefined) setValues.tags = patch.tags ?? [];
    if (patch.collectionId !== undefined) {
      // Validate existence so an invalid id is a typed 400, not a raw FK
      // violation. A null clears the collection (no existence check needed).
      if (patch.collectionId != null) {
        await assertCollectionExists(patch.collectionId);
      }
      setValues.collectionId = patch.collectionId ?? null;
    }
    if (patch.status !== undefined) {
      // "published" is NOT a plain metadata transition — it must go through
      // `publishService.publish()`, which creates the `content_publications`
      // row, calls the destination adapter, emits `content.published`, and
      // enforces the §26.4 public-publish gate. Writing it directly here
      // (content:update alone, no content:publish_internal/publish_public)
      // would leave `status: "published"` with none of that: a caller could
      // mark content "published" while it was never actually published
      // anywhere, and — for a caller who otherwise couldn't pass the gate —
      // outside the audited/gated flow entirely. "draft" and "archived"
      // remain plain metadata transitions.
      if (patch.status === "published") {
        throw new ValidationError(
          "Cannot set status to 'published' via update — use the publish endpoint/tool instead",
          { status: patch.status }
        );
      }
      setValues.status = patch.status;
    }

    const rows = await executeQuery(
      (db) =>
        db
          .update(contentObjects)
          .set(setValues)
          .where(eq(contentObjects.id, existing.id))
          .returning(objectSelectFields),
      "content.update"
    );
    // Guard against a concurrent delete between load and update (TOCTOU): the
    // RETURNING yields no row, so surface a clean NotFoundError, not a TypeError.
    if (!rows[0]) throw new NotFoundError("Content not found", { id });
    return rowToObjectDTO(rows[0] as ObjectRowAsText);
  },
};

/** Throw NotFoundError (not Forbidden) when the requester cannot view the object. */
async function assertViewable(
  req: Requester,
  obj: ContentObjectDTO,
  ref: string
): Promise<void> {
  const viewable = await visibilityService.canView(req, {
    id: obj.id,
    ownerUserId: obj.ownerUserId,
    visibilityLevel: obj.visibilityLevel,
  });
  if (!viewable) throw new NotFoundError("Content not found", { ref });
}

/**
 * The user id that owns content created by this requester. Delegated agents own
 * as their human; users own themselves; autonomous agents own as the configured
 * system user (§26.5).
 */
function ownerFor(req: Requester): number {
  if (req.kind === "user") {
    // A guest (userId null) cannot own content; create is never reached by a
    // guest, but fail loudly rather than coerce to a bogus owner id.
    if (req.userId == null) {
      throw new ForbiddenError("Authentication required to own content");
    }
    return req.userId;
  }
  if (req.kind === "agent-delegated") return req.actingForUserId;
  // Autonomous: owned by the configured system user (§26.5).
  return systemUserId();
}
