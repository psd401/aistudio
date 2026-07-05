/**
 * Atrium retrieval service — Phase 6 (Issue #1056, Epic #1059).
 *
 * Closes the "content as context" loop: published content becomes
 * permission-aware retrieval grounding for assistants. Reuses the existing
 * repository/vector-search pipeline (`knowledge_repositories`,
 * `repository_items`, `repository_item_chunks`, `lib/repositories/search-service.ts`)
 * rather than building a parallel index (spec §33 #4) — every indexed Atrium
 * object lives as a `repository_item` in one shared, system-owned repository,
 * linked back via `content_index_links` (Phase 0).
 *
 * The safety boundary: `search` and `getContextDocument` both re-check
 * `visibilityService.canView` against a freshly loaded object before
 * returning anything — never trust the mirrored retrieval metadata for a
 * permission decision (spec §16.2, §28.2).
 *
 * See docs/features/atrium-design-spec.md §16.
 */

import { eq, inArray } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import {
  contentIndexLinks,
  contentObjects,
  knowledgeRepositories,
  repositoryItemChunks,
  repositoryItems,
  assistantArchitects,
  type AssistantRetrievalScope,
} from "@/lib/db/schema";
import { chunkText } from "@/lib/document-processing";
import { generateEmbeddings } from "@/lib/ai-helpers";
import { vectorSearch } from "@/lib/repositories/search-service";
import { createLogger } from "@/lib/logger";
import { contentService } from "./content-service";
import { versionService } from "./version-service";
import { visibilityService } from "./visibility-service";
import { s3Store } from "./storage/s3-store";
import { systemUserId } from "./helpers";
import type { ContentObjectDTO, Requester, VisibilityLevel } from "./types";

const log = createLogger({ module: "atrium-retrieval-service" });

/** Name of the single, system-owned repository that backs all Atrium retrieval. */
const ATRIUM_REPOSITORY_NAME = "Atrium Content Index";

/** A retrieval scope narrows candidates BEFORE `canView` is enforced (§16.4). */
export type RetrievalScope = AssistantRetrievalScope;

export interface RetrievalHit {
  objectId: string;
  title: string;
  slug: string;
  chunkId: number;
  content: string;
  similarity: number;
  chunkIndex: number;
}

const VISIBILITY_RANK: Record<VisibilityLevel, number> = {
  private: 0,
  group: 1,
  internal: 2,
  public: 3,
};

let cachedRepositoryId: number | null = null;

/** Reset the in-process repository-id cache. Test-only. */
export function _resetAtriumRepositoryCacheForTests(): void {
  cachedRepositoryId = null;
}

/**
 * Get (or lazily create) the single system-owned `knowledge_repositories` row
 * that backs the Atrium retrieval index. Cached per-process — the row is
 * effectively immutable once created.
 */
async function getAtriumRepositoryId(): Promise<number> {
  if (cachedRepositoryId != null) return cachedRepositoryId;

  const existing = await executeQuery(
    (db) =>
      db
        .select({ id: knowledgeRepositories.id })
        .from(knowledgeRepositories)
        .where(eq(knowledgeRepositories.name, ATRIUM_REPOSITORY_NAME))
        .limit(1),
    "retrieval.getAtriumRepository"
  );
  if (existing[0]) {
    cachedRepositoryId = existing[0].id;
    return cachedRepositoryId;
  }

  const [created] = await executeQuery(
    (db) =>
      db
        .insert(knowledgeRepositories)
        .values({
          name: ATRIUM_REPOSITORY_NAME,
          description:
            "System-managed retrieval index for published Atrium content (Phase 6, Issue #1056). Do not edit directly.",
          ownerId: systemUserId(),
          isPublic: false,
          // Flag this repo as system-managed so the GENERIC repository actions
          // (searchRepository/getRepository/listRepositoryItems) refuse to read
          // it. Atrium content is governed by a finer-grained permission model
          // (per-hit `canView`, §16.2) than repository-level access — without
          // this flag, `searchRepository` (which enforces no repo-level authz)
          // would let any authenticated user search the shared index directly
          // and bypass `canView`. All Atrium reads must go through
          // `retrievalService` (Issue #1056 review finding).
          metadata: { systemManaged: true, purpose: "atrium-retrieval" },
        })
        .returning({ id: knowledgeRepositories.id }),
    "retrieval.createAtriumRepository"
  );
  if (!created) {
    throw new Error("Failed to create the Atrium retrieval repository");
  }
  cachedRepositoryId = created.id;
  return cachedRepositoryId;
}

/** Load the source text for an object's current version (document or artifact). */
async function loadIndexableText(
  obj: ContentObjectDTO,
  version: Awaited<ReturnType<typeof versionService.current>>
): Promise<string> {
  if (!version) return "";
  if (obj.kind === "document") {
    return s3Store.getText(s3Store.key(obj.id, version.versionNumber, "source.md"));
  }
  // Artifacts: strip to the underlying source so search sees visible text/labels
  // rather than opaque binary — the code itself is still searchable text.
  return versionService.loadArtifactCode(version);
}

/**
 * Index (or re-index) one published object: chunk + embed its current
 * version's text, upsert the backing `repository_item`/`repository_item_chunks`,
 * link via `content_index_links`, and stamp `content_objects.indexed_at`.
 *
 * No-op when the object doesn't exist, isn't published, or has no current
 * version/text. Safe to call repeatedly (idempotent re-index on new versions).
 */
async function indexObject(objectId: string): Promise<void> {
  const obj = await contentService.loadByIdOrSlug(objectId);
  if (!obj || obj.status !== "published") return;

  const version = await versionService.current(obj.id);
  if (!version) return;

  const text = await loadIndexableText(obj, version);
  if (!text.trim()) {
    log.warn("Skipping retrieval index: empty content", { objectId: obj.id });
    return;
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) return;

  // Embedding generation is external IO (Bedrock/OpenAI) — run it BEFORE the
  // transaction, never inside one, so a slow provider call never holds a DB
  // transaction open.
  const embeddings = await generateEmbeddings(chunks);
  // Fail loudly on a provider count mismatch rather than writing chunks with
  // `undefined` embeddings (which `vectorSearch`'s `embedding IS NOT NULL`
  // filter would silently drop). Publish catches + logs this best-effort.
  if (embeddings.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch for ${obj.id}: ${embeddings.length} embeddings for ${chunks.length} chunks`
    );
  }
  const grants = await visibilityService.grantsFor(obj.id);

  // Filterable retrieval metadata mirror (§16.1). This is NEVER the source of
  // permission truth — `search`/`getContextDocument` always re-check
  // `canView` against a freshly loaded `content_objects` row.
  const metadata: Record<string, unknown> = {
    objectId: obj.id,
    kind: obj.kind,
    collectionId: obj.collectionId,
    visibilityLevel: obj.visibilityLevel,
    tags: obj.tags,
    grants,
  };

  const repositoryId = await getAtriumRepositoryId();

  // `repository_items.type` has a CHECK constraint (document | url | text). An
  // Atrium artifact is indexed as its extracted source *text*, so map it to
  // "text" (documents keep "document"). Without this, an artifact insert
  // violates the constraint and — because publish treats indexing as a swallowed
  // best-effort side effect — the artifact would publish but never get indexed.
  const repositoryItemType = obj.kind === "document" ? "document" : "text";

  await executeTransaction(async (tx: DbTransaction) => {
    const existingLink = await tx
      .select({
        id: contentIndexLinks.id,
        repositoryItemId: contentIndexLinks.repositoryItemId,
      })
      .from(contentIndexLinks)
      .where(eq(contentIndexLinks.objectId, obj.id))
      .limit(1);

    let itemId: number;
    if (existingLink[0]) {
      itemId = existingLink[0].repositoryItemId;
      await tx
        .update(repositoryItems)
        .set({
          name: obj.title,
          metadata,
          processingStatus: "completed",
          updatedAt: new Date(),
        })
        .where(eq(repositoryItems.id, itemId));
      await tx
        .delete(repositoryItemChunks)
        .where(eq(repositoryItemChunks.itemId, itemId));
    } else {
      const [createdItem] = await tx
        .insert(repositoryItems)
        .values({
          repositoryId,
          type: repositoryItemType,
          name: obj.title,
          source: `atrium:${obj.slug}`,
          metadata,
          processingStatus: "completed",
        })
        .returning({ id: repositoryItems.id });
      if (!createdItem) throw new Error("Failed to create repository item");
      itemId = createdItem.id;
    }

    await tx.insert(repositoryItemChunks).values(
      chunks.map((content, i) => ({
        itemId,
        content,
        chunkIndex: i,
        metadata,
        embedding: embeddings[i],
        tokens: null,
      }))
    );

    if (existingLink[0]) {
      await tx
        .update(contentIndexLinks)
        .set({ indexedVersionId: version.id, updatedAt: new Date() })
        .where(eq(contentIndexLinks.id, existingLink[0].id));
    } else {
      await tx.insert(contentIndexLinks).values({
        objectId: obj.id,
        repositoryItemId: itemId,
        indexedVersionId: version.id,
      });
    }

    await tx
      .update(contentObjects)
      .set({ indexedAt: new Date() })
      .where(eq(contentObjects.id, obj.id));
  }, "retrieval.indexObject");
}

/**
 * Remove one object from the retrieval index — the inverse of `indexObject`.
 * Deletes the backing `repository_item` + its chunks + the `content_index_links`
 * row and clears `content_objects.indexed_at`, all in one transaction.
 *
 * Idempotent: an unindexed object (no link row) is a silent no-op. Callers are
 * the de-exposure paths — `publishService.unpublish` once NO destination remains
 * live, and `contentService.update` on an archive transition — so content that
 * is no longer published anywhere stops surfacing as assistant context. A later
 * re-publish re-indexes cleanly: `indexObject` sees no link and creates a fresh
 * item/link pair.
 */
async function removeFromIndex(objectId: string): Promise<void> {
  await executeTransaction(async (tx: DbTransaction) => {
    const link = await tx
      .select({
        id: contentIndexLinks.id,
        repositoryItemId: contentIndexLinks.repositoryItemId,
      })
      .from(contentIndexLinks)
      .where(eq(contentIndexLinks.objectId, objectId))
      .limit(1);
    if (!link[0]) return; // never indexed / already pruned — idempotent no-op

    // Chunks first, then the link (it references the item), then the item.
    // The FK cascades would cover chunks/link on item delete, but explicit
    // ordering keeps the transaction deterministic and self-documenting.
    await tx
      .delete(repositoryItemChunks)
      .where(eq(repositoryItemChunks.itemId, link[0].repositoryItemId));
    await tx
      .delete(contentIndexLinks)
      .where(eq(contentIndexLinks.id, link[0].id));
    await tx
      .delete(repositoryItems)
      .where(eq(repositoryItems.id, link[0].repositoryItemId));
    await tx
      .update(contentObjects)
      .set({ indexedAt: null })
      .where(eq(contentObjects.id, objectId));
  }, "retrieval.removeFromIndex");
  log.info("Removed content from retrieval index", { objectId });
}

/** Does `obj` satisfy the (optional) collection/tags/max-visibility scope? */
function withinScope(obj: ContentObjectDTO, scope?: RetrievalScope): boolean {
  if (!scope) return true;
  if (scope.collectionId && obj.collectionId !== scope.collectionId) return false;
  if (
    scope.tags &&
    scope.tags.length > 0 &&
    !scope.tags.some((t) => obj.tags.includes(t))
  ) {
    return false;
  }
  if (
    scope.maxVisibilityLevel &&
    VISIBILITY_RANK[obj.visibilityLevel] > VISIBILITY_RANK[scope.maxVisibilityLevel]
  ) {
    return false;
  }
  return true;
}

/**
 * Permission-aware semantic search over indexed Atrium content (§16.2 — the
 * safety boundary). Runs the existing vector search scoped to the Atrium
 * repository, resolves each hit back to its `content_objects` row via
 * `content_index_links`, narrows by the optional scope, then drops any hit the
 * requester cannot `canView` — never returns what the requester can't see.
 */
async function search(
  req: Requester,
  query: string,
  scope?: RetrievalScope,
  opts?: { limit?: number; threshold?: number }
): Promise<RetrievalHit[]> {
  const repositoryId = await getAtriumRepositoryId();
  const hits = await vectorSearch(query, {
    limit: opts?.limit ?? 10,
    threshold: opts?.threshold,
    repositoryId,
  });
  if (hits.length === 0) return [];

  const itemIds = Array.from(new Set(hits.map((h) => h.itemId)));
  const links = await executeQuery(
    (db) =>
      db
        .select({
          objectId: contentIndexLinks.objectId,
          repositoryItemId: contentIndexLinks.repositoryItemId,
        })
        .from(contentIndexLinks)
        .where(inArray(contentIndexLinks.repositoryItemId, itemIds)),
    "retrieval.resolveLinks"
  );
  const itemToObjectId = new Map(links.map((l) => [l.repositoryItemId, l.objectId]));

  const objCache = new Map<string, ContentObjectDTO | null>();
  const results: RetrievalHit[] = [];
  for (const hit of hits) {
    const objectId = itemToObjectId.get(hit.itemId);
    if (!objectId) continue;

    let obj = objCache.get(objectId);
    if (obj === undefined) {
      obj = await contentService.loadByIdOrSlug(objectId);
      objCache.set(objectId, obj);
    }
    if (!obj || obj.status !== "published") continue;
    if (!withinScope(obj, scope)) continue;

    // The safety boundary: never return what the requester can't see.
    const visible = await visibilityService.canView(req, {
      id: obj.id,
      ownerUserId: obj.ownerUserId,
      visibilityLevel: obj.visibilityLevel,
    });
    if (!visible) continue;

    results.push({
      objectId: obj.id,
      title: obj.title,
      slug: obj.slug,
      chunkId: hit.chunkId,
      content: hit.content,
      similarity: hit.similarity,
      chunkIndex: hit.chunkIndex,
    });
  }
  return results;
}

/**
 * Whole-object injection (§16.3, the `context.md` pattern): returns the full
 * markdown/source text of a published object verbatim, or `null` if it
 * doesn't exist, isn't published, or the requester cannot view it.
 */
async function getContextDocument(
  req: Requester,
  objectId: string
): Promise<string | null> {
  const obj = await contentService.loadByIdOrSlug(objectId);
  if (!obj || obj.status !== "published") return null;

  const visible = await visibilityService.canView(req, {
    id: obj.id,
    ownerUserId: obj.ownerUserId,
    visibilityLevel: obj.visibilityLevel,
  });
  if (!visible) return null;

  const version = await versionService.current(obj.id);
  if (!version) return null;

  return loadIndexableText(obj, version);
}

/**
 * Assistant retrieval scoping (§16.4): loads the calling assistant's stored
 * `retrievalScope` and runs a scoped `search`. `canView` still enforces
 * per-requester access on top of the scope — so the same content store
 * safely serves a staff assistant and a student assistant differently.
 */
async function searchForAssistant(
  req: Requester,
  assistantId: number,
  query: string,
  opts?: { limit?: number; threshold?: number }
): Promise<RetrievalHit[]> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ retrievalScope: assistantArchitects.retrievalScope })
        .from(assistantArchitects)
        .where(eq(assistantArchitects.id, assistantId))
        .limit(1),
    "retrieval.loadAssistantScope"
  );
  // Fail closed on an unknown assistant: return nothing rather than silently
  // running an UNSCOPED search. `canView` still gates every hit, so this is not
  // the security boundary — but a missing/invalid assistant id should not widen
  // beyond the assistant's intended scope.
  if (rows.length === 0) return [];
  const scope = rows[0].retrievalScope ?? undefined;
  return search(req, query, scope, opts);
}

export const retrievalService = {
  indexObject,
  removeFromIndex,
  search,
  getContextDocument,
  searchForAssistant,
};
