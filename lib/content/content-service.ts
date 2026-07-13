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

import { and, count, eq, like, sql } from "drizzle-orm";
import { createLogger } from "@/lib/logger";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import {
  contentAuditLogs,
  contentCollections,
  contentObjects,
  contentPublications,
  contentVersions,
  navigationItems,
} from "@/lib/db/schema";
import { safeJsonbStringify } from "@/lib/db/json-utils";
import {
  actorKindOf,
  agentIdOf,
  assertCanCreate,
  assertCanDelete,
  assertCanEdit,
  canPublishPublic,
  persistPublishApprovalRequest,
  slugCandidate,
  slugifyTitle,
  systemUserId,
} from "./helpers";
import { contentAuditInsertValues, type ContentAuditSurface } from "./audit";
import { contentEvents } from "./events";
import { screenAgentBodyForWrite } from "./agent-screening";
import {
  objectSelectFields,
  rowToObjectDTO,
  type ObjectRowAsText,
} from "./mappers";
import { snapshotInTx, versionService } from "./version-service";
import { visibilityService } from "./visibility-service";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./errors";
import type {
  ContentKind,
  ContentObjectDTO,
  ContentObjectWithVersion,
  CreateObjectInput,
  ListFilter,
  Requester,
  SnapshotInput,
  UpdatePatch,
  VisibilityGrant,
  VisibilityLevel,
} from "./types";

/** What a successful hard delete returns — the identity of what was removed. */
export interface DeletedContentSummary {
  id: string;
  slug: string;
  title: string;
  kind: ContentKind;
  /** Immutable version rows removed with the object (cascade). */
  versionsDeleted: number;
}

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
 * Slice-F presentation columns (cover gradient + emoji icon) as a TYPED
 * `setValues` partial. Both use `?? null` so an explicit clear writes NULL (never
 * `undefined`, which Drizzle would drop — the silent-failure pattern for clearable
 * fields). Extracted from `update()` to keep that method's control flow flat; the
 * values are already validated at the action boundary (`updateContentAction`).
 */
function presentationSetValues(
  patch: UpdatePatch
): Partial<typeof contentObjects.$inferInsert> {
  const values: Partial<typeof contentObjects.$inferInsert> = {};
  if (patch.coverGradient !== undefined) {
    values.coverGradient = patch.coverGradient ?? null;
  }
  if (patch.icon !== undefined) values.icon = patch.icon ?? null;
  return values;
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

/**
 * Validate `create`'s title/kind input, throwing typed 400s. Enforces the
 * varchar(500) column limit as a `ValidationError` rather than a raw Postgres
 * 22001 ("value too long") error. Extracted from `create` (complexity budget).
 */
function assertValidCreateInput(input: CreateObjectInput): void {
  if (!input.title?.trim()) {
    throw new ValidationError("Title is required");
  }
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
}

/**
 * §26.4 create-as-private (issue #1118 item 2). An unauthorized public CREATE is
 * NOT blocked: the object is created PRIVATE (the caller downgrades the resolved
 * level, see `resolveCreateVisibility`) and this queues a durable
 * `visibility_widen` request for the now-existing object. Previously the create
 * gate threw with NOTHING persisted, so the request never reached /admin/atrium
 * and the caller's content was lost.
 *
 * Runs POST-commit (the object id must exist to reference it) and is best-effort:
 * `persistPublishApprovalRequest` never rejects (it log.warns), so a queue-write
 * failure cannot fail an already-successful create. Emits the same approval-queue
 * event the other §26.4 gates emit — now carrying the real object id (a
 * `visibility_widen` on the created object) rather than the old object-less
 * `destination: "create"` placeholder.
 */
async function queuePublicWidenForCreate(
  req: Requester,
  objectId: string
): Promise<void> {
  await persistPublishApprovalRequest(req, { objectId }, { objectId });
  void contentEvents.emit("content.public_publish_requested", {
    objectId,
    actorKind: actorKindOf(req),
    agentLabel: req.kind === "user" ? null : req.agentLabel,
  });
}

/**
 * Resolve the visibility level + grants a create persists, enforcing the
 * grant/level invariants and the §26.4 create-as-private downgrade. Extracted
 * from `create` (complexity budget); the ordering vs. `ownerFor` is unchanged.
 * `publicWidenRequested` is true when an unauthorized public create was
 * downgraded to private — the caller queues a `visibility_widen` post-commit.
 */
async function resolveCreateVisibility(
  req: Requester,
  input: CreateObjectInput,
  mayPublishPublic: boolean
): Promise<{
  visibilityLevel: VisibilityLevel;
  grants: VisibilityGrant[];
  publicWidenRequested: boolean;
}> {
  const explicitLevel = input.visibility?.level;
  const grants = input.visibility?.grants ?? [];

  // A group object with no grants is invisible to everyone but the owner/admin
  // (equivalent to private without the semantics) — almost always a mistake.
  // The authoritative enforcement is `applyGrantsForLevel` in the create
  // transaction (against the RESOLVED level, so a collection-defaulted `group`
  // is covered too); this is a cheap pre-transaction fast-fail for the common
  // explicit-group case.
  if (explicitLevel === "group" && grants.length === 0) {
    throw new ValidationError(
      "group visibility requires at least one grant"
    );
  }

  let visibilityLevel: VisibilityLevel =
    explicitLevel ??
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
  if (explicitLevel == null && visibilityLevel === "group" && grants.length === 0) {
    visibilityLevel = "private";
  }

  // Validate the RESOLVED level + grants BEFORE the transaction so an invalid
  // combination (e.g. an explicit `group` with no grants) fails without
  // writing — and rolling back — an object row. The pre-transaction guard
  // above only catches the explicit-`group` case.
  visibilityService.assertWritableLevel(visibilityLevel, grants);

  // §26.4 create-as-private (issue #1118 item 2): creating directly at `public`
  // (explicitly, or via a collection whose admin-set default is `public`)
  // without authority is NOT blocked. Downgrade to `private` — always the safe
  // direction (no exposure) — and signal the caller to queue a `visibility_widen`
  // once the object exists. `grants` are dropped: a public object carries none.
  // Covers BOTH an explicit `public` input and a public collection default (e.g.
  // the seeded `public-site` collection, default_visibility_level = 'public'),
  // since `visibilityLevel` here is the RESOLVED level.
  if (visibilityLevel === "public" && !mayPublishPublic) {
    return { visibilityLevel: "private", grants: [], publicWidenRequested: true };
  }

  return { visibilityLevel, grants, publicWidenRequested: false };
}

export const contentService = {
  loadByIdOrSlug,

  /**
   * Create a content object. When `input.body` is supplied, an initial version
   * (v1) is snapshotted in the same transaction and becomes the object's head.
   *
   * §26.4 create-as-private (issue #1118 item 2) — creating an object directly at
   * `visibility.level === "public"` (explicitly, or via a public collection
   * default) without authority (`content:publish_public` / admin) is NOT blocked:
   * the object is created PRIVATE and a durable `visibility_widen` request is
   * queued for it (visible in /admin/atrium, replayed on approve). So `create`
   * still cannot become a side door around `publish` — an unauthorized caller
   * never lands public content — but its content is preserved and the request is
   * durable. The caller passes `hasPublishPublicCapability` (the session's
   * explicit capability); agent requesters are resolved from `req` alone.
   */
  async create(
    req: Requester,
    input: CreateObjectInput,
    opts: { hasPublishPublicCapability?: boolean } = {}
  ): Promise<ContentObjectWithVersion> {
    assertCanCreate(req);
    assertValidCreateInput(input);

    // Whether this caller holds the §26.4 public-publish authority (pure, no IO).
    const mayPublishPublic = canPublishPublic(
      req,
      opts.hasPublishPublicCapability ?? false
    );

    const ownerUserId = ownerFor(req);
    // Use the shared resolvers so object-level provenance matches version-level
    // (snapshotInTx uses the same helpers): actor === 'agent' iff an agent id is
    // recorded (autonomous only); delegated agents record as 'human'.
    const createdByActor = actorKindOf(req);
    const createdByAgentId = agentIdOf(req);

    // Resolve level + grants. An unauthorized public create is downgraded to
    // private here (create-as-private, §26.4); `publicWidenRequested` then drives
    // the post-commit `visibility_widen` queue below.
    const { visibilityLevel, grants, publicWidenRequested } =
      await resolveCreateVisibility(req, input, mayPublishPublic);

    // §28.3 — agent-authored bodies (a document's markdown AND an artifact's
    // code) are guardrails/PII-screened BEFORE any write, mirroring the agent
    // bridge. No-op for human/delegated authors and bodyless creates. Runs
    // pre-transaction: screening is external IO (Bedrock) that must never hold
    // a pooled connection. Fail-closed: blocked or unscreenable content throws
    // ValidationError and nothing is created. The returned proof is asserted
    // inside `snapshotInTx` (issue #1118 item 3).
    const screeningProof = await screenAgentBodyForWrite(req, input.body, null);

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
            { body: input.body, bodyFormat: input.bodyFormat },
            screeningProof
          );
          // Reflect the new head id without a re-select.
          dto.currentVersionId = snap.version.id;
          return { object: dto, version: snap.version, s3Writes: snap.s3Writes };
        }
        return { object: dto, version: null, s3Writes: [] };
      },
      "content.create"
    );

    // §26.4 create-as-private (issue #1118 item 2): the object was created private
    // because the caller lacked public-publish authority — queue a durable widen
    // request now that its id exists. Post-commit + best-effort (never throws).
    // MUST run before the S3 flush: flushSnapshotWrites throws on blob-write
    // failure, and the committed-but-unqueued object would otherwise be stuck
    // private with no admin-visible approval row.
    if (publicWidenRequested) {
      await queuePublicWidenForCreate(req, object.id);
    }

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

    // §28.3 — screen ONCE, OUTSIDE the conflict-retry (issue #1118 item 7).
    // Screening is unmemoized external IO (Bedrock Guardrails + Comprehend); a
    // back-to-back autosave that loses the version-number race and retries would
    // otherwise screen the identical body twice (extra latency/cost, and a
    // transient "degraded" verdict on the 2nd call could reject already-passed
    // content). The proof is reused across both snapshot attempts.
    const proof = await screenAgentBodyForWrite(req, input.body, obj.id);

    // The version-number allocation (`MAX(version_number) + 1`) is intentionally
    // race-prone and the unique constraint maps a loser to ConflictError (409).
    // Back-to-back writers (e.g. an autosave firing twice) would otherwise surface
    // an unrecoverable error toast. A single transparent retry re-reads the head
    // version and almost always wins the second time; a still-conflicting second
    // attempt (sustained contention) re-throws so the caller can decide. Both
    // attempts reuse the single screening proof above.
    let version: Awaited<ReturnType<typeof versionService.snapshotScreened>>;
    try {
      version = await versionService.snapshotScreened(
        req,
        { id: obj.id, kind: obj.kind },
        input,
        proof
      );
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      version = await versionService.snapshotScreened(
        req,
        { id: obj.id, kind: obj.kind },
        input,
        proof
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

  /**
   * Lean load for an EDIT gate (no current-version join): resolve the object,
   * enforce existence-masking (404 before 403) then the edit gate, and return the
   * object. Used by the `set_visibility` surfaces, which only need `ownerUserId`
   * and the resolved id before `visibilityService.setLevel` re-selects the row
   * `FOR UPDATE` — so the version load that `get()` does would be wasted here.
   */
  async loadForEdit(
    req: Requester,
    idOrSlug: string
  ): Promise<ContentObjectDTO> {
    const obj = await loadByIdOrSlug(idOrSlug);
    if (!obj) throw new NotFoundError("Content not found", { idOrSlug });
    // 404 (not 403) on a non-viewable object to avoid leaking existence, BEFORE
    // the edit-permission check.
    await assertViewable(req, obj, idOrSlug);
    assertCanEdit(req, obj.ownerUserId);
    return obj;
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
    // Slice-F presentation fields (cover gradient + emoji icon), validated at the
    // action boundary and merged as a typed partial (see presentationSetValues).
    Object.assign(setValues, presentationSetValues(patch));

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

    // A transition OUT of `published` (to `draft` or `archived`) must take the
    // object offline everywhere and stop it surfacing as assistant context. Both
    // readers gate ONLY on a live `content_publications` row (never on `status`),
    // so without the takedown a "drafted" or "archived" object stays fully live at
    // its permanent reader URL — a content-exposure footgun. The takedown is a
    // removal (no §26.4 gate; assertCanEdit already ran), AWAITED, and its failure
    // surfaces: silently leaving public content live is the exact exposure these
    // status changes are expected to prevent.
    if (patch.status === "draft" || patch.status === "archived") {
      const { publishService } = await import("./publish-service");
      await publishService.retractAllPublications(existing.id);
      // Retrieval-index prune (§16): best-effort + idempotent (a re-save retries a
      // previously failed prune); runs on every draft/archived write, not just the
      // first transition.
      await pruneRetrievalIndexBestEffort(existing.id);
    }
    return rowToObjectDTO(rows[0] as ObjectRowAsText);
  },

  /**
   * HARD-DELETE an object: remove its row and every dependent row/body permanently.
   * The single delete path for every surface (REST, skill, Nexus chat tool, UI).
   *
   * Guards, in strict order (an unviewable object must never reveal its existence):
   *  1. 404 (NotFound) when the object doesn't exist OR the requester cannot
   *     `canView` it — existence-masking BEFORE any permission signal.
   *  2. 403 (Forbidden) unless the requester is the OWNER or an admin (agents also
   *     need the `content:delete` scope) — `assertCanDelete`.
   *  3. 409 (Conflict) when the object is LIVE at any destination — delete NEVER
   *     auto-retracts a publication; the caller must `unpublish` first. Checked as
   *     a fast pre-flight AND authoritatively on the FOR-UPDATE-locked row inside
   *     the transaction (TOCTOU-safe, per the §26.4 gate-order lesson).
   * Any kind/status otherwise (draft / archived / private / internal) is deletable —
   * the guards above are the protection, not the lifecycle status.
   *
   * Ordering that makes an external-cleanup failure UNABLE to orphan DB state:
   *  - Retrieval-index removal runs via the sanctioned `retrievalService.removeFromIndex`
   *    BEFORE the delete tx (it reads `content_index_links` to find the SHARED
   *    `repository_item`, which the object-delete cascade would otherwise erase —
   *    leaving orphaned shared rows). It opens its own tx (can't nest) and is a
   *    no-op for an unindexed object.
   *  - ALL row deletes happen in ONE transaction: a `delete` audit row is written
   *    (capturing title/kind/owner that the cascade erases), then the object row is
   *    deleted — cascading `content_versions`, `content_publications`,
   *    `atrium_doc_state`, `atrium_doc_comments`, `content_embed_links`,
   *    `content_visibility_grants`, `content_publish_requests`, `content_index_links`
   *    via their ON DELETE CASCADE FKs. `content_audit_logs` has no FK to the object,
   *    so the trail SURVIVES.
   *  - S3 body cleanup runs AFTER the commit, best-effort: an orphaned S3 key is
   *    invisible (its DB rows are gone) and only logged, never rolled back into the
   *    committed delete.
   */
  async delete(
    req: Requester,
    id: string,
    opts: { surface: ContentAuditSurface }
  ): Promise<DeletedContentSummary> {
    const existing = await loadByIdOrSlug(id);
    if (!existing) throw new NotFoundError("Content not found", { id });
    // 404 (not 403) on a non-viewable object to avoid leaking existence, BEFORE
    // the delete-permission check.
    await assertViewable(req, existing, id);
    // 403 unless owner/admin (agents also need content:delete).
    assertCanDelete(req, existing.ownerUserId);

    // Pre-flight: refuse while any destination is live (never auto-retract). This
    // is a fast, racy rejection + a clear message; the tx re-checks authoritatively.
    const { publishService } = await import("./publish-service");
    const liveBefore = await publishService.liveDestinations(existing.id);
    if (liveBefore.length > 0) {
      throw new ConflictError(
        `Cannot delete published content — unpublish from ${liveBefore.join(
          ", "
        )} first, then delete.`,
        { objectId: existing.id, liveDestinations: liveBefore }
      );
    }

    // Clean the SHARED retrieval index (repository_item + chunks) via the sanctioned
    // inverse BEFORE the delete tx — see the method doc. Runs in its own tx.
    const { retrievalService } = await import("./retrieval-service");
    await retrievalService.removeFromIndex(existing.id);

    let versionsDeleted: number;
    try {
      versionsDeleted = await executeTransaction(async (tx) => {
      // Lock the object row so a concurrent publish cannot slip a live publication
      // in between the pre-flight check and the delete (TOCTOU).
      const locked = await tx
        .select({ id: contentObjects.id })
        .from(contentObjects)
        .where(eq(contentObjects.id, existing.id))
        .for("update")
        .limit(1);
      // Concurrent delete already removed it — surface cleanly, don't double-delete.
      if (!locked[0]) {
        throw new NotFoundError("Content not found", { id: existing.id });
      }

      // AUTHORITATIVE live-publication guard on the locked row.
      const live = await tx
        .select({ destination: contentPublications.destination })
        .from(contentPublications)
        .where(
          and(
            eq(contentPublications.objectId, existing.id),
            eq(contentPublications.status, "live")
          )
        );
      if (live.length > 0) {
        throw new ConflictError(
          `Cannot delete published content — unpublish from ${live
            .map((l) => l.destination)
            .join(", ")} first, then delete.`,
          { objectId: existing.id }
        );
      }

      const [versionCountRow] = await tx
        .select({ value: count() })
        .from(contentVersions)
        .where(eq(contentVersions.objectId, existing.id));
      const vCount = Number(versionCountRow?.value ?? 0);

      // Audit BEFORE the row disappears (in-tx = atomic with the delete): the
      // object_id becomes a dangling UUID after this, so `details` is the only
      // durable record of what was removed.
      await tx.insert(contentAuditLogs).values(
        contentAuditInsertValues({
          req,
          action: "delete",
          surface: opts.surface,
          objectId: existing.id,
          outcome: "ok",
          details: {
            title: existing.title,
            kind: existing.kind,
            ownerUserId: existing.ownerUserId,
            versionsDeleted: vCount,
          },
        })
      );

      // Remove the object's intranet nav entry FIRST. `navigation_items.content_object_id`
      // is ON DELETE NO ACTION (not cascade) and unpublish only SOFT-hides the row
      // (navItemService.hideNavItem sets is_active=false, never deletes it), so a
      // published-then-unpublished object still carries a nav row that would block the
      // object delete's end-of-statement FK check. Deleting it in the SAME tx clears
      // the reference before the object row goes. (A never-published object has none —
      // this is a no-op.) A content nav item is a leaf, so nothing cascades off it.
      await tx
        .delete(navigationItems)
        .where(eq(navigationItems.contentObjectId, existing.id));

      // The object row + everything ON DELETE CASCADE hangs off it (versions,
      // publications, doc_state, doc_comments, embed_links, visibility_grants,
      // publish_requests, index_links). content_publications.published_version_id is
      // NO ACTION but both it and the version cascade-delete here, so the deferred
      // end-of-statement check sees no dangling reference.
      await tx.delete(contentObjects).where(eq(contentObjects.id, existing.id));
      return vCount;
      }, "content.delete");
    } catch (err) {
      // The pre-flight index prune runs BEFORE this tx (it needs the not-yet-cascaded
      // content_index_links to find the shared repository_item via the sanctioned
      // removeFromIndex). If the AUTHORITATIVE in-tx guard then aborts the delete —
      // a publish committed between the racy pre-flight liveDestinations() read and
      // the FOR-UPDATE lock — the object stays live+published but has already been
      // de-indexed. Re-index it (best-effort, fire-and-forget) so a REFUSED delete
      // never silently drops still-live content out of assistant retrieval. Only the
      // in-tx live-publication guard raises ConflictError inside the tx.
      if (err instanceof ConflictError) {
        void retrievalService
          .indexObject(existing.id)
          .catch((reindexError) =>
            createLogger({ action: "content.delete" }).warn(
              "Re-index after aborted delete failed (object left de-indexed until next publish/edit)",
              {
                objectId: existing.id,
                error:
                  reindexError instanceof Error
                    ? reindexError.message
                    : String(reindexError),
              }
            )
          );
      }
      throw err;
    }

    const log = createLogger({ action: "content.delete" });
    // Best-effort external cleanup AFTER commit — orphaned S3 keys are acceptable.
    // Lazy import (like publish-service/retrieval-service above): a static import
    // pulls s3-store → settings-manager → drizzle into content-service's module
    // graph, which breaks unit tests that import this module with only shallow mocks.
    try {
      const { s3Store } = await import("./storage/s3-store");
      const s3KeysDeleted = await s3Store.deleteObjectTree(existing.id);
      log.info("Deleted content object", {
        objectId: existing.id,
        slug: existing.slug,
        kind: existing.kind,
        versionsDeleted,
        s3KeysDeleted,
        surface: opts.surface,
      });
    } catch (s3Error) {
      log.warn("Content deleted; S3 body cleanup failed (orphaned keys acceptable)", {
        objectId: existing.id,
        error: s3Error instanceof Error ? s3Error.message : String(s3Error),
      });
    }

    // Lifecycle event AFTER commit, best-effort (never throws) — subscribers that
    // cached the object learn it is gone.
    void contentEvents.emit("content.deleted", {
      objectId: existing.id,
      slug: existing.slug,
      actorKind: actorKindOf(req),
      agentLabel: req.kind === "user" ? null : req.agentLabel,
    });

    return {
      id: existing.id,
      slug: existing.slug,
      title: existing.title,
      kind: existing.kind,
      versionsDeleted,
    };
  },
};

/**
 * Best-effort retrieval-index prune for the archive path. The metadata update
 * has already committed, so a prune failure is logged, never thrown. Lazy
 * import: retrieval-service statically imports THIS module, so a static import
 * back would create a cycle.
 */
async function pruneRetrievalIndexBestEffort(objectId: string): Promise<void> {
  try {
    const { retrievalService } = await import("./retrieval-service");
    await retrievalService.removeFromIndex(objectId);
  } catch (pruneError) {
    createLogger({ action: "content.update" }).warn(
      "Failed to prune retrieval index after archive",
      {
        objectId,
        error:
          pruneError instanceof Error ? pruneError.message : String(pruneError),
      }
    );
  }
}

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
