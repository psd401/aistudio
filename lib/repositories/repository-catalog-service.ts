import "server-only";

import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { getUserAccessibleRepositories } from "@/lib/db/drizzle";
import {
  executeQuery,
  toPgRows,
} from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryItems,
} from "@/lib/db/schema";
import { retrieveRepositoryContent } from "./retrieval-v2/service";
import type {
  RetrievalMode,
  RetrievalModality,
} from "./retrieval-v2/types";

const MAX_REPOSITORIES = 50;
const MAX_RESULTS = 50;
const MAX_SOURCE_SEGMENTS = 50;
const MAX_CHANGES = 100;

export interface RepositoryCatalogEntry {
  id: number;
  name: string;
  description: string | null;
  ownerName: string | null;
  visibility: "public" | "private";
  itemCount: number;
  activeIndexGenerationId: string | null;
  lastUpdated: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface RepositorySourceSegment {
  chunkId: number;
  itemId: number;
  itemStableId: string;
  itemName: string;
  itemVersionId: string;
  versionNumber: number;
  chunkIndex: number;
  modality: string;
  content: string;
  contextPrefix: string;
  sourceLocator: Record<string, unknown>;
}

interface SourceRow {
  chunk_id: number;
  item_id: number;
  item_stable_id: string;
  item_name: string;
  item_version_id: string;
  version_number: number;
  chunk_index: number;
  modality: string;
  content: string;
  context_prefix: string;
  source_locator: Record<string, unknown>;
}

interface ChangeCursor {
  updatedAt: string;
  itemId: number;
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clamp(value: number | undefined, fallback: number, maximum: number) {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), maximum);
}

function mapCatalogEntry(
  repository: Awaited<ReturnType<typeof getUserAccessibleRepositories>>[number]
): RepositoryCatalogEntry {
  return {
    id: repository.id,
    name: repository.name,
    description: repository.description,
    ownerName: repository.ownerName,
    visibility: repository.isPublic ? "public" : "private",
    itemCount: Number(repository.itemCount),
    activeIndexGenerationId: repository.activeIndexGenerationId,
    lastUpdated: toIso(repository.lastUpdated),
    createdAt: toIso(repository.createdAt),
    updatedAt: toIso(repository.updatedAt),
  };
}

export async function listRepositoryCatalog(
  cognitoSub: string,
  options: { query?: string; limit?: number } = {}
): Promise<RepositoryCatalogEntry[]> {
  const query = options.query?.trim().toLocaleLowerCase();
  const limit = clamp(options.limit, MAX_REPOSITORIES, MAX_REPOSITORIES);
  const repositories = await getUserAccessibleRepositories(cognitoSub);
  return repositories
    .filter((repository) => {
      if (!query) return true;
      return (
        repository.name.toLocaleLowerCase().includes(query) ||
        repository.description?.toLocaleLowerCase().includes(query) === true
      );
    })
    .slice(0, limit)
    .map(mapCatalogEntry);
}

export async function describeRepository(
  cognitoSub: string,
  repositoryId: number
): Promise<RepositoryCatalogEntry | null> {
  const repositories = await getUserAccessibleRepositories(cognitoSub);
  const repository = repositories.find((row) => row.id === repositoryId);
  return repository ? mapCatalogEntry(repository) : null;
}

export async function searchRepositoryCatalog(input: {
  cognitoSub: string;
  query: string;
  repositoryIds?: number[];
  mode?: RetrievalMode;
  modalities?: RetrievalModality[];
  limit?: number;
  threshold?: number;
}) {
  const requestedIds =
    input.repositoryIds?.filter(
      (id) => Number.isSafeInteger(id) && id > 0
    ) ?? [];
  const repositoryIds =
    requestedIds.length > 0
      ? requestedIds.slice(0, MAX_REPOSITORIES)
      : (await listRepositoryCatalog(input.cognitoSub)).map(
          (repository) => repository.id
        );
  return retrieveRepositoryContent({
    query: input.query,
    repositoryIds,
    userCognitoSub: input.cognitoSub,
    mode: input.mode,
    modalities: input.modalities,
    limit: clamp(input.limit, 10, MAX_RESULTS),
    threshold: input.threshold,
  });
}

/**
 * Return exact source segments only from the repository's currently active
 * generation and the item's current immutable version. Repository and segment
 * ACLs are re-evaluated in this disclosure statement so revocation cannot race
 * an earlier list/describe call.
 */
export async function getRepositorySource(input: {
  userId: number;
  repositoryId: number;
  itemId: number;
  chunkId?: number;
  limit?: number;
}): Promise<RepositorySourceSegment[]> {
  const limit = clamp(input.limit, 20, MAX_SOURCE_SEGMENTS);
  const chunkPredicate =
    input.chunkId == null
      ? sql`TRUE`
      : sql`chunk.id = ${input.chunkId}`;
  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT
          chunk.id AS chunk_id,
          item.id AS item_id,
          item.stable_id::text AS item_stable_id,
          item.name AS item_name,
          version.id::text AS item_version_id,
          version.version_number,
          chunk.chunk_index,
          chunk.modality,
          chunk.content,
          chunk.context_prefix,
          chunk.source_locator
        FROM knowledge_repositories repository
        JOIN repository_items item
          ON item.repository_id = repository.id
        JOIN repository_item_versions version
          ON version.id = item.current_version_id
        JOIN repository_item_chunks chunk
          ON chunk.item_id = item.id
         AND chunk.item_version_id = version.id
         AND chunk.index_generation_id = repository.active_index_generation_id
        WHERE repository.id = ${input.repositoryId}
          AND item.id = ${input.itemId}
          AND ${chunkPredicate}
          AND repository.repository_kind = 'durable'
          AND (repository.metadata ->> 'systemManaged')
            IS DISTINCT FROM 'true'
          AND repository.lifecycle_status = 'active'
          AND (repository.expires_at IS NULL OR repository.expires_at > now())
          AND item.lifecycle_status = 'active'
          AND (item.expires_at IS NULL OR item.expires_at > now())
          AND (
            repository.is_public = true
            OR repository.owner_id = ${input.userId}
            OR EXISTS (
              SELECT 1
              FROM repository_access repository_acl
              WHERE repository_acl.repository_id = repository.id
                AND (
                  repository_acl.user_id = ${input.userId}
                  OR EXISTS (
                    SELECT 1
                    FROM user_roles membership
                    WHERE membership.user_id = ${input.userId}
                      AND membership.role_id = repository_acl.role_id
                  )
                )
            )
          )
          AND (
            NOT (
              chunk.access_scope ? 'userIds'
              OR chunk.access_scope ? 'roleIds'
            )
            OR (
              jsonb_typeof(chunk.access_scope -> 'userIds') = 'array'
              AND chunk.access_scope -> 'userIds'
                @> to_jsonb(ARRAY[${input.userId}]::integer[])
            )
            OR (
              jsonb_typeof(chunk.access_scope -> 'roleIds') = 'array'
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(chunk.access_scope -> 'roleIds') role_value
                JOIN user_roles membership
                  ON membership.user_id = ${input.userId}
                 AND role_value = to_jsonb(membership.role_id)
              )
            )
          )
        ORDER BY chunk.chunk_index ASC, chunk.id ASC
        LIMIT ${limit}
      `),
    "getRepositoryCatalogSource"
  );
  return toPgRows<SourceRow>(result).map((row) => ({
    chunkId: row.chunk_id,
    itemId: row.item_id,
    itemStableId: row.item_stable_id,
    itemName: row.item_name,
    itemVersionId: row.item_version_id,
    versionNumber: row.version_number,
    chunkIndex: row.chunk_index,
    modality: row.modality,
    content: row.content,
    contextPrefix: row.context_prefix,
    sourceLocator: row.source_locator,
  }));
}

function decodeChangeCursor(cursor: string | undefined): ChangeCursor | null {
  if (!cursor) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    );
    if (
      !decoded ||
      typeof decoded !== "object" ||
      !("updatedAt" in decoded) ||
      !("itemId" in decoded)
    ) {
      return null;
    }
    const updatedAt = Reflect.get(decoded, "updatedAt");
    const itemId = Reflect.get(decoded, "itemId");
    if (
      typeof updatedAt !== "string" ||
      Number.isNaN(new Date(updatedAt).getTime()) ||
      typeof itemId !== "number" ||
      !Number.isSafeInteger(itemId)
    ) {
      return null;
    }
    return { updatedAt, itemId };
  } catch {
    return null;
  }
}

function encodeChangeCursor(cursor: ChangeCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export async function listRepositoryChanges(input: {
  userId: number;
  repositoryIds?: number[];
  cursor?: string;
  limit?: number;
}) {
  const requestedIds =
    input.repositoryIds?.filter(
      (id) => Number.isSafeInteger(id) && id > 0
    ) ?? [];
  const repositoryIds = requestedIds.slice(0, MAX_REPOSITORIES);
  if (repositoryIds.length === 0) {
    return { changes: [], nextCursor: null };
  }

  const cursor = decodeChangeCursor(input.cursor);
  if (input.cursor && !cursor) {
    throw new Error("Invalid repository changes cursor");
  }
  const limit = clamp(input.limit, 50, MAX_CHANGES);
  const cursorPredicate = cursor
    ? or(
        gt(repositoryItems.updatedAt, new Date(cursor.updatedAt)),
        and(
          eq(repositoryItems.updatedAt, new Date(cursor.updatedAt)),
          gt(repositoryItems.id, cursor.itemId)
        )
      )
    : undefined;
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          repositoryId: knowledgeRepositories.id,
          repositoryName: knowledgeRepositories.name,
          activeIndexGenerationId:
            knowledgeRepositories.activeIndexGenerationId,
          itemId: repositoryItems.id,
          itemStableId: repositoryItems.stableId,
          itemName: repositoryItems.name,
          lifecycleStatus: repositoryItems.lifecycleStatus,
          currentVersionId: repositoryItems.currentVersionId,
          updatedAt: repositoryItems.updatedAt,
        })
        .from(repositoryItems)
        .innerJoin(
          knowledgeRepositories,
          eq(knowledgeRepositories.id, repositoryItems.repositoryId)
        )
        .where(
          and(
            inArray(repositoryItems.repositoryId, repositoryIds),
            eq(knowledgeRepositories.repositoryKind, "durable"),
            eq(knowledgeRepositories.lifecycleStatus, "active"),
            sql`(
              (${knowledgeRepositories.metadata} ->> 'systemManaged')
                IS DISTINCT FROM 'true'
              AND (
                ${knowledgeRepositories.expiresAt} IS NULL
                OR ${knowledgeRepositories.expiresAt} > now()
              )
            )`,
            or(
              eq(knowledgeRepositories.isPublic, true),
              eq(knowledgeRepositories.ownerId, input.userId),
              sql`EXISTS (
                SELECT 1
                FROM repository_access repository_acl
                WHERE repository_acl.repository_id = ${knowledgeRepositories.id}
                  AND (
                    repository_acl.user_id = ${input.userId}
                    OR EXISTS (
                      SELECT 1
                      FROM user_roles membership
                      WHERE membership.user_id = ${input.userId}
                        AND membership.role_id = repository_acl.role_id
                    )
                  )
              )`
            ),
            cursorPredicate
          )
        )
        .orderBy(asc(repositoryItems.updatedAt), asc(repositoryItems.id))
        .limit(limit + 1),
    "listRepositoryCatalogChanges"
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    changes: page.map((row) => ({
      ...row,
      updatedAt: toIso(row.updatedAt),
    })),
    nextCursor:
      rows.length > limit && last?.updatedAt
        ? encodeChangeCursor({
            updatedAt: toIso(last.updatedAt) ?? new Date(0).toISOString(),
            itemId: last.itemId,
          })
        : null,
  };
}
