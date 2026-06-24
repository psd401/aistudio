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

import { eq, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import { contentCollections, contentObjects } from "@/lib/db/schema";
import { pgTimestampAsText } from "@/lib/db/drizzle-helpers";
import { safeJsonbStringify } from "@/lib/db/json-utils";
import {
  assertCanCreate,
  assertCanEdit,
  slugCandidate,
  slugifyTitle,
} from "./helpers";
import { rowToObjectDTO, type ObjectRowAsText } from "./mappers";
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

const objectSelectFields = {
  id: contentObjects.id,
  kind: contentObjects.kind,
  title: contentObjects.title,
  slug: contentObjects.slug,
  ownerUserId: contentObjects.ownerUserId,
  createdByActor: contentObjects.createdByActor,
  createdByAgentId: contentObjects.createdByAgentId,
  collectionId: contentObjects.collectionId,
  visibilityLevel: contentObjects.visibilityLevel,
  currentVersionId: contentObjects.currentVersionId,
  sourceRef: contentObjects.sourceRef,
  tags: contentObjects.tags,
  status: contentObjects.status,
  indexedAt: pgTimestampAsText(contentObjects.indexedAt),
  createdAt: pgTimestampAsText(contentObjects.createdAt),
  updatedAt: pgTimestampAsText(contentObjects.updatedAt),
} as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Allocate a unique slug for a title within the create transaction. */
async function uniqueSlug(tx: DbTransaction, title: string): Promise<string> {
  const base = slugifyTitle(title);
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const candidate = slugCandidate(base, attempt);
    const existing = await tx
      .select({ id: contentObjects.id })
      .from(contentObjects)
      .where(eq(contentObjects.slug, candidate))
      .limit(1);
    if (!existing[0]) return candidate;
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

/** Load an object by id (UUID) or slug. Returns the DTO or null. */
async function loadByIdOrSlug(
  idOrSlug: string
): Promise<ContentObjectDTO | null> {
  const where = UUID_RE.test(idOrSlug)
    ? eq(contentObjects.id, idOrSlug)
    : eq(contentObjects.slug, idOrSlug);
  const rows = await executeQuery(
    (db) => db.select(objectSelectFields).from(contentObjects).where(where).limit(1),
    "content.loadByIdOrSlug"
  );
  return rows[0] ? rowToObjectDTO(rows[0] as ObjectRowAsText) : null;
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
    const createdByActor = req.kind === "user" ? "human" : "agent";
    const createdByAgentId =
      req.kind === "agent-autonomous" ? req.agentId : null;

    const { object, version } = await executeTransaction(async (tx) => {
      const slug = await uniqueSlug(tx, input.title);
      const visibilityLevel: VisibilityLevel =
        input.visibility?.level ??
        (await collectionDefault(tx, input.collectionId)) ??
        "private";

      const [row] = await tx
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
        .returning(objectSelectFields);

      await visibilityService.applyGrants(
        tx,
        row.id,
        input.visibility?.grants ?? []
      );

      const dto = rowToObjectDTO(row as ObjectRowAsText);

      if (input.body !== undefined) {
        const v = await snapshotInTx(
          tx,
          req,
          { id: dto.id, kind: input.kind },
          { body: input.body, bodyFormat: input.bodyFormat }
        );
        // Reflect the new head id without a re-select.
        dto.currentVersionId = v.id;
        return { object: dto, version: v };
      }
      return { object: dto, version: null };
    }, "content.create");

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
    assertCanEdit(req, obj.ownerUserId);

    const version = await versionService.snapshot(
      req,
      { id: obj.id, kind: obj.kind },
      input
    );
    return { ...obj, currentVersionId: version.id, version };
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
    assertCanEdit(req, existing.ownerUserId);

    const setValues: Record<string, unknown> = { updatedAt: new Date() };
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
    return rowToObjectDTO(rows[0] as ObjectRowAsText);
  },
};

/**
 * The user id that owns content created by this requester. Delegated agents own
 * as their human; users own themselves; autonomous agents own as the configured
 * system user (§26.5).
 */
function ownerFor(req: Requester): number {
  if (req.kind === "user") return req.userId;
  if (req.kind === "agent-delegated") return req.actingForUserId;
  // Autonomous: owned by the configured system user.
  const systemUserId = Number(process.env.ATRIUM_SYSTEM_USER_ID);
  if (!Number.isInteger(systemUserId) || systemUserId <= 0) {
    throw new ValidationError(
      "ATRIUM_SYSTEM_USER_ID must be configured for autonomous-agent content"
    );
  }
  return systemUserId;
}

// Re-export the filtered list type for convenience.
export type { ListFilter } from "./types";
