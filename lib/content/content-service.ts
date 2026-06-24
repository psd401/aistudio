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
import { ConflictError, NotFoundError, ValidationError } from "./errors";
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

const MAX_SLUG_ATTEMPTS = 25;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * up-to-25 sequential round-trips while the transaction held a pooled connection.
 * The final guard is the `content_objects.slug` unique constraint, which the
 * INSERT's `isUniqueViolation` catch translates into a `ConflictError` on the
 * rare concurrent-create race.
 */
async function uniqueSlug(tx: DbTransaction, title: string): Promise<string> {
  const base = slugifyTitle(title);
  // `_` and `%` are not producible by slugifyTitle (it emits [a-z0-9-] only), so
  // no LIKE-wildcard escaping is required for the base prefix.
  const taken = new Set(
    (
      await tx
        .select({ slug: contentObjects.slug })
        .from(contentObjects)
        .where(like(contentObjects.slug, `${base}%`))
    ).map((r) => r.slug)
  );
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const candidate = slugCandidate(base, attempt);
    if (!taken.has(candidate)) return candidate;
  }
  throw new ConflictError("Could not allocate a unique slug", { base });
}

/** Resolve a collection's default visibility level, or null if no collection. */
async function collectionDefault(
  tx: DbTransaction,
  collectionId: string | undefined
): Promise<VisibilityLevel | null> {
  if (!collectionId) return null;
  const rows = await tx
    .select({ level: contentCollections.defaultVisibilityLevel })
    .from(contentCollections)
    .where(eq(contentCollections.id, collectionId))
    .limit(1);
  if (!rows[0]) {
    throw new ValidationError("Collection not found", { collectionId });
  }
  return rows[0].level as VisibilityLevel;
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
    input: CreateObjectInput
  ): Promise<ContentObjectWithVersion> {
    assertCanCreate(req);

    if (!input.title?.trim()) {
      throw new ValidationError("Title is required");
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
    if (
      input.visibility?.level === "group" &&
      (input.visibility.grants?.length ?? 0) === 0
    ) {
      throw new ValidationError(
        "group visibility requires at least one grant"
      );
    }

    const { object, version, s3Writes } = await executeTransaction(
      async (tx) => {
        const slug = await uniqueSlug(tx, input.title);
        const visibilityLevel: VisibilityLevel =
          input.visibility?.level ??
          (await collectionDefault(tx, input.collectionId)) ??
          "private";

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

        await visibilityService.applyGrants(
          tx,
          row.id,
          input.visibility?.grants ?? []
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

    const version = await versionService.snapshot(
      req,
      { id: obj.id, kind: obj.kind },
      input
    );
    // Re-load so the returned object carries the post-snapshot updatedAt and
    // currentVersionId (snapshotInTx advances both); returning the pre-snapshot
    // `obj` would hand callers a stale updatedAt for cache/optimistic-lock use.
    const refreshed = await loadByIdOrSlug(obj.id);
    return { ...(refreshed ?? obj), currentVersionId: version.id, version };
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

    const viewable = await visibilityService.canView(req, {
      id: obj.id,
      ownerUserId: obj.ownerUserId,
      visibilityLevel: obj.visibilityLevel,
    });
    if (!viewable) {
      // 404 (not 403) to avoid leaking existence of non-viewable content.
      throw new NotFoundError("Content not found", { idOrSlug });
    }

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
      setValues.title = patch.title;
    }
    if (patch.tags !== undefined) setValues.tags = patch.tags ?? null;
    if (patch.collectionId !== undefined)
      setValues.collectionId = patch.collectionId ?? null;
    if (patch.status !== undefined) setValues.status = patch.status;

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
  if (req.kind === "user") return req.userId;
  if (req.kind === "agent-delegated") return req.actingForUserId;
  // Autonomous: owned by the configured system user (§26.5).
  return systemUserId();
}

// Re-export the filtered list type for convenience.
export type { ListFilter } from "./types";
