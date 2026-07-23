import { and, eq, sql } from "drizzle-orm";
import { generateEmbedding } from "@/lib/ai-helpers";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  getAccessibleRepositoriesByCognitoSub,
  getUserByCognitoSub,
} from "@/lib/db/drizzle";
import { userRoles } from "@/lib/db/schema";
import type { RepositorySourceLocator } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { getContentPlatformConfig } from "@/lib/repositories/content-platform/config";
import {
  countRepositoryTokens,
  truncateToRepositoryTokens,
} from "@/lib/repositories/content-platform/token-segmentation";
import { parseRepositoryEmbeddingDescriptor } from "@/lib/repositories/embedding-configuration";
import { applyRerankScores, diversifyBySource, reciprocalRankFusion } from "./ranking";
import { BedrockRepositoryReranker, type RepositoryReranker } from "./bedrock-reranker";
import { resolveRetrievalCitation } from "./citations";
import { generateVisualQueryEmbedding } from "./visual-embedding";
import type {
  RepositoryRetrievalRequest,
  RetrievalCandidate,
  RetrievalContextSegment,
  RetrievalGenerationSnapshot,
  RetrievalModality,
  RetrievalResponse,
  RetrievalResult,
} from "./types";

interface RetrievalPrincipal {
  userId: number;
  roleIds: number[];
}

interface RetrievalDependencies {
  generateTextEmbedding?: typeof generateEmbedding;
  generateVisualEmbedding?: typeof generateVisualQueryEmbedding;
  reranker?: RepositoryReranker;
}

type CandidateSignal = "dense" | "lexical" | "visual";

const ALL_MODALITIES: RetrievalModality[] = [
  "text",
  "image",
  "audio",
  "video",
  "table",
];

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function mapCandidate(
  row: Record<string, unknown>,
  signal: CandidateSignal
): RetrievalCandidate {
  const rawScore = Number(row.score) || 0;
  return {
    chunkId: Number(row.chunk_id),
    repositoryId: Number(row.repository_id),
    repositoryName: String(row.repository_name ?? ""),
    generationId: String(row.generation_id),
    itemId: Number(row.item_id),
    itemStableId: String(row.item_stable_id),
    itemName: String(row.item_name ?? ""),
    itemVersionId: String(row.item_version_id),
    versionNumber: Number(row.version_number),
    artifactId: typeof row.artifact_id === "string" ? row.artifact_id : null,
    content: String(row.content ?? ""),
    contextPrefix: String(row.context_prefix ?? ""),
    chunkIndex: Number(row.chunk_index),
    parentChunkIndex:
      row.parent_chunk_index == null ? null : Number(row.parent_chunk_index),
    segmentLevel:
      row.segment_level === "document" || row.segment_level === "section"
        ? row.segment_level
        : "chunk",
    modality: ALL_MODALITIES.includes(row.modality as RetrievalModality)
      ? (row.modality as RetrievalModality)
      : "text",
    sourceLocator: parseRecord(row.source_locator) as RepositorySourceLocator,
    tokens: Math.max(1, Number(row.tokens) || countRepositoryTokens(String(row.content ?? ""))),
    metadata: parseRecord(row.metadata),
    fusedScore: 0,
    ...(signal === "dense" ? { denseScore: rawScore } : {}),
    ...(signal === "lexical" ? { lexicalScore: rawScore } : {}),
    ...(signal === "visual" ? { visualScore: rawScore } : {}),
  };
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function legacySourceLocator(
  row: Record<string, unknown>
): RepositorySourceLocator {
  const sourceLocator = parseRecord(row.source_locator) as RepositorySourceLocator;
  if (Object.keys(sourceLocator).length > 0) return sourceLocator;

  const metadata = parseRecord(row.metadata);
  const page = positiveInteger(metadata.page ?? metadata.pageNumber);
  if (page) return { page };
  const paragraph = positiveInteger(metadata.paragraph ?? metadata.paragraphNumber);
  if (paragraph) return { paragraph };
  const slide = positiveInteger(metadata.slide ?? metadata.slideNumber);
  if (slide) return { slide };

  return { headingPath: [String(row.item_name ?? "Legacy repository source")] };
}

function mapLegacyCandidate(row: Record<string, unknown>): RetrievalCandidate {
  const rawScore = Number(row.score) || 0;
  const itemId = Number(row.item_id);
  return {
    chunkId: Number(row.chunk_id),
    repositoryId: Number(row.repository_id),
    repositoryName: String(row.repository_name ?? ""),
    generationId: `legacy:${row.repository_id}`,
    itemId,
    itemStableId: String(row.item_stable_id),
    itemName: String(row.item_name ?? ""),
    itemVersionId: `legacy:${itemId}`,
    versionNumber: 0,
    artifactId: null,
    content: String(row.content ?? ""),
    contextPrefix: "",
    chunkIndex: Number(row.chunk_index),
    parentChunkIndex: null,
    segmentLevel: "chunk",
    modality: ALL_MODALITIES.includes(row.modality as RetrievalModality)
      ? (row.modality as RetrievalModality)
      : "text",
    sourceLocator: legacySourceLocator(row),
    tokens: Math.max(
      1,
      Number(row.tokens) || countRepositoryTokens(String(row.content ?? ""))
    ),
    metadata: {
      ...parseRecord(row.metadata),
      retrievalCompatibility: "legacy-v1",
    },
    fusedScore: 0,
    lexicalScore: rawScore,
  };
}

async function resolvePrincipal(cognitoSub: string): Promise<RetrievalPrincipal | null> {
  const user = await getUserByCognitoSub(cognitoSub);
  if (!user) return null;
  const roles = await executeQuery(
    (db) =>
      db
        .select({ roleId: userRoles.roleId })
        .from(userRoles)
        .where(and(eq(userRoles.userId, user.id), sql`${userRoles.roleId} IS NOT NULL`)),
    "retrievalV2.principalRoles"
  );
  return {
    userId: user.id,
    roleIds: roles.flatMap((row) => (row.roleId == null ? [] : [row.roleId])),
  };
}

async function resolveSnapshots(
  repositoryIds: number[]
): Promise<RetrievalGenerationSnapshot[]> {
  if (repositoryIds.length === 0) return [];
  const rows = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT
          repository.id AS repository_id,
          repository.name AS repository_name,
          generation.id AS generation_id,
          generation.embedding_model,
          generation.embedding_dimensions,
          generation.visual_embedding_model,
          generation.visual_embedding_dimensions
        FROM knowledge_repositories repository
        JOIN repository_index_generations generation
          ON generation.id = repository.active_index_generation_id
        WHERE repository.id IN (${sql.join(
          repositoryIds.map((repositoryId) => sql`${repositoryId}`),
          sql`, `
        )})
          AND repository.lifecycle_status = 'active'
          AND (
            repository.expires_at IS NULL
            OR repository.expires_at > now()
          )
          AND (repository.metadata->>'systemManaged') IS DISTINCT FROM 'true'
          AND generation.status = 'active'
      `),
    "retrievalV2.resolveGenerationSnapshots"
  );
  return (rows as unknown as Array<Record<string, unknown>>).map((row) => {
    const embedding = parseRepositoryEmbeddingDescriptor(
      typeof row.embedding_model === "string" ? row.embedding_model : null,
      Number(row.embedding_dimensions)
    );
    const visual = parseRepositoryEmbeddingDescriptor(
      typeof row.visual_embedding_model === "string"
        ? row.visual_embedding_model
        : null,
      row.visual_embedding_dimensions == null
        ? null
        : Number(row.visual_embedding_dimensions)
    );
    return {
      repositoryId: Number(row.repository_id),
      repositoryName: String(row.repository_name ?? ""),
      generationId: String(row.generation_id),
      embeddingModel: embedding?.descriptor ?? null,
      embeddingDimensions: embedding?.dimensions ?? null,
      visualEmbeddingModel: visual?.descriptor ?? null,
      visualEmbeddingDimensions: visual?.dimensions ?? null,
    };
  });
}

function accessFilter(principal: RetrievalPrincipal) {
  const rolePredicate =
    principal.roleIds.length > 0
      ? sql`role_value IN (${sql.join(
          principal.roleIds.map(
            (roleId) => sql`to_jsonb(${roleId}::integer)`
          ),
          sql`, `
        )})`
      : sql`false`;
  return sql`
    (
      NOT (chunk.access_scope ? 'userIds' OR chunk.access_scope ? 'roleIds')
      OR (
        jsonb_typeof(chunk.access_scope->'userIds') = 'array'
        AND chunk.access_scope->'userIds' @>
          to_jsonb(ARRAY[${principal.userId}]::integer[])
      )
      OR (
        jsonb_typeof(chunk.access_scope->'roleIds') = 'array'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(chunk.access_scope->'roleIds') role_value
          WHERE CASE
            WHEN jsonb_typeof(role_value) = 'number'
              THEN ${rolePredicate}
            ELSE false
          END
        )
      )
    )
  `;
}

/**
 * Re-check repository-level access in the same statement that supplies model
 * context. Candidate discovery can race with an ACL update, so the earlier
 * getAccessibleRepositoriesByCognitoSub result is not sufficient at disclosure
 * time.
 */
function repositoryAccessFilter(principal: RetrievalPrincipal) {
  return sql`
    (
      repository.is_public = true
      OR repository.owner_id = ${principal.userId}
      OR EXISTS (
        SELECT 1
        FROM repository_access repository_acl
        WHERE repository_acl.repository_id = repository.id
          AND (
            repository_acl.user_id = ${principal.userId}
            OR EXISTS (
              SELECT 1
              FROM user_roles user_role_membership
              WHERE user_role_membership.user_id = ${principal.userId}
                AND user_role_membership.role_id = repository_acl.role_id
            )
          )
      )
    )
  `;
}

/**
 * Unlike candidate discovery, disclosure-time role checks must query current
 * membership rather than rely on the role snapshot resolved earlier.
 */
function currentSegmentAccessFilter(principal: RetrievalPrincipal) {
  return sql`
    (
      NOT (chunk.access_scope ? 'userIds' OR chunk.access_scope ? 'roleIds')
      OR (
        jsonb_typeof(chunk.access_scope->'userIds') = 'array'
        AND chunk.access_scope->'userIds' @>
          to_jsonb(ARRAY[${principal.userId}]::integer[])
      )
      OR (
        jsonb_typeof(chunk.access_scope->'roleIds') = 'array'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(chunk.access_scope->'roleIds') role_value
          WHERE CASE
            WHEN jsonb_typeof(role_value) = 'number'
              THEN EXISTS (
                SELECT 1
                FROM user_roles user_role_membership
                WHERE user_role_membership.user_id = ${principal.userId}
                  AND role_value =
                    to_jsonb(user_role_membership.role_id)
              )
            ELSE false
          END
        )
      )
    )
  `;
}

function candidateColumns() {
  return sql`
    chunk.id AS chunk_id,
    repository.id AS repository_id,
    repository.name AS repository_name,
    chunk.index_generation_id AS generation_id,
    item.id AS item_id,
    item.stable_id AS item_stable_id,
    item.name AS item_name,
    version.id AS item_version_id,
    version.version_number,
    chunk.artifact_id,
    chunk.content,
    chunk.context_prefix,
    chunk.chunk_index,
    chunk.parent_chunk_index,
    chunk.segment_level,
    chunk.modality,
    chunk.source_locator,
    chunk.tokens,
    chunk.metadata
  `;
}

async function denseCandidates(
  snapshot: RetrievalGenerationSnapshot,
  principal: RetrievalPrincipal,
  embedding: number[],
  modalities: RetrievalModality[],
  limit: number,
  threshold: number
): Promise<RetrievalCandidate[]> {
  const vector = `[${embedding.join(",")}]`;
  const rows = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT ${candidateColumns()},
          1 - (chunk.embedding <=> ${vector}::vector) AS score
        FROM repository_item_chunks chunk
        JOIN repository_items item ON item.id = chunk.item_id
        JOIN repository_item_versions version ON version.id = chunk.item_version_id
        JOIN knowledge_repositories repository ON repository.id = item.repository_id
        WHERE chunk.index_generation_id = ${snapshot.generationId}::uuid
          AND repository.id = ${snapshot.repositoryId}
          AND repository.lifecycle_status = 'active'
          AND (
            repository.expires_at IS NULL
            OR repository.expires_at > now()
          )
          AND chunk.embedding IS NOT NULL
          AND chunk.modality IN (${sql.join(
            modalities.map((modality) => sql`${modality}`),
            sql`, `
          )})
          AND item.lifecycle_status = 'active'
          AND version.storage_status = 'available'
          AND version.inspection_status IN ('clean', 'not_required')
          AND version.processing_status = 'completed'
          AND ${repositoryAccessFilter(principal)}
          AND ${accessFilter(principal)}
          AND 1 - (chunk.embedding <=> ${vector}::vector) >= ${threshold}
        ORDER BY score DESC, chunk.id
        LIMIT ${limit}
      `),
    "retrievalV2.denseCandidates"
  );
  return (rows as unknown as Array<Record<string, unknown>>).map((row) =>
    mapCandidate(row, "dense")
  );
}

async function lexicalCandidates(
  snapshot: RetrievalGenerationSnapshot,
  principal: RetrievalPrincipal,
  query: string,
  modalities: RetrievalModality[],
  limit: number
): Promise<RetrievalCandidate[]> {
  const rows = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT ${candidateColumns()},
          ts_rank_cd(
            chunk.search_vector,
            websearch_to_tsquery('english', ${query}),
            32
          ) AS score
        FROM repository_item_chunks chunk
        JOIN repository_items item ON item.id = chunk.item_id
        JOIN repository_item_versions version ON version.id = chunk.item_version_id
        JOIN knowledge_repositories repository ON repository.id = item.repository_id
        WHERE chunk.index_generation_id = ${snapshot.generationId}::uuid
          AND repository.id = ${snapshot.repositoryId}
          AND repository.lifecycle_status = 'active'
          AND (
            repository.expires_at IS NULL
            OR repository.expires_at > now()
          )
          AND chunk.modality IN (${sql.join(
            modalities.map((modality) => sql`${modality}`),
            sql`, `
          )})
          AND item.lifecycle_status = 'active'
          AND version.storage_status = 'available'
          AND version.inspection_status IN ('clean', 'not_required')
          AND version.processing_status = 'completed'
          AND ${repositoryAccessFilter(principal)}
          AND ${accessFilter(principal)}
          AND chunk.search_vector @@ websearch_to_tsquery('english', ${query})
        ORDER BY score DESC, chunk.id
        LIMIT ${limit}
      `),
    "retrievalV2.lexicalCandidates"
  );
  return (rows as unknown as Array<Record<string, unknown>>).map((row) =>
    mapCandidate(row, "lexical")
  );
}

/**
 * Keep pre-migration repository content searchable during the dual-write and
 * backfill window. A legacy chunk is omitted as soon as that item has a chunk
 * in the repository's active canonical generation, preventing stale duplicate
 * disclosure while avoiding a read-cutover hole for URL/text items.
 */
async function legacyCompatibilityCandidates(
  repositoryIds: number[],
  principal: RetrievalPrincipal,
  query: string,
  modalities: RetrievalModality[],
  limit: number
): Promise<RetrievalCandidate[]> {
  if (repositoryIds.length === 0) return [];
  const rows = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT
          chunk.id AS chunk_id,
          repository.id AS repository_id,
          repository.name AS repository_name,
          item.id AS item_id,
          item.stable_id AS item_stable_id,
          item.name AS item_name,
          chunk.content,
          chunk.chunk_index,
          chunk.modality,
          chunk.source_locator,
          chunk.tokens,
          chunk.metadata,
          ts_rank_cd(
            chunk.search_vector,
            websearch_to_tsquery('english', ${query}),
            32
          ) AS score
        FROM repository_item_chunks chunk
        JOIN repository_items item ON item.id = chunk.item_id
        JOIN knowledge_repositories repository ON repository.id = item.repository_id
        WHERE repository.id IN (${sql.join(
          repositoryIds.map((repositoryId) => sql`${repositoryId}`),
          sql`, `
        )})
          AND chunk.item_version_id IS NULL
          AND chunk.index_generation_id IS NULL
          AND chunk.modality IN (${sql.join(
            modalities.map((modality) => sql`${modality}`),
            sql`, `
          )})
          AND item.lifecycle_status = 'active'
          AND item.processing_status = 'completed'
          AND repository.lifecycle_status = 'active'
          AND (
            repository.expires_at IS NULL
            OR repository.expires_at > now()
          )
          AND (repository.metadata->>'systemManaged') IS DISTINCT FROM 'true'
          AND ${repositoryAccessFilter(principal)}
          AND ${accessFilter(principal)}
          AND chunk.search_vector @@ websearch_to_tsquery('english', ${query})
          AND NOT EXISTS (
            SELECT 1
            FROM repository_item_chunks current_chunk
            WHERE current_chunk.item_id = item.id
              AND current_chunk.item_version_id IS NOT NULL
              AND current_chunk.index_generation_id = repository.active_index_generation_id
          )
        ORDER BY score DESC, chunk.id
        LIMIT ${limit}
      `),
    "retrievalV2.legacyCompatibilityCandidates"
  );
  return (rows as unknown as Array<Record<string, unknown>>).map(
    mapLegacyCandidate
  );
}

async function visualCandidates(
  snapshot: RetrievalGenerationSnapshot,
  principal: RetrievalPrincipal,
  embedding: number[],
  limit: number,
  threshold: number
): Promise<RetrievalCandidate[]> {
  const vector = `[${embedding.join(",")}]`;
  const rows = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT ${candidateColumns()},
          1 - (chunk.visual_embedding <=> ${vector}::vector) AS score
        FROM repository_item_chunks chunk
        JOIN repository_items item ON item.id = chunk.item_id
        JOIN repository_item_versions version ON version.id = chunk.item_version_id
        JOIN knowledge_repositories repository ON repository.id = item.repository_id
        WHERE chunk.index_generation_id = ${snapshot.generationId}::uuid
          AND repository.id = ${snapshot.repositoryId}
          AND repository.lifecycle_status = 'active'
          AND (
            repository.expires_at IS NULL
            OR repository.expires_at > now()
          )
          AND chunk.visual_embedding IS NOT NULL
          AND chunk.modality IN ('image', 'video')
          AND item.lifecycle_status = 'active'
          AND version.storage_status = 'available'
          AND version.inspection_status IN ('clean', 'not_required')
          AND version.processing_status = 'completed'
          AND ${repositoryAccessFilter(principal)}
          AND ${accessFilter(principal)}
          AND 1 - (chunk.visual_embedding <=> ${vector}::vector) >= ${threshold}
        ORDER BY score DESC, chunk.id
        LIMIT ${limit}
      `),
    "retrievalV2.visualCandidates"
  );
  return (rows as unknown as Array<Record<string, unknown>>).map((row) =>
    mapCandidate(row, "visual")
  );
}

/**
 * A managed reranker is an external disclosure boundary. Candidate discovery
 * can race with ACL, role, lifecycle, or active-generation changes, so only
 * rows re-authorized immediately before the provider call may leave the
 * application process. Final context expansion performs the same checks again
 * before returning content to the caller.
 */
async function revalidateCandidatesForRerank(
  candidates: RetrievalCandidate[],
  principal: RetrievalPrincipal
): Promise<RetrievalCandidate[]> {
  if (candidates.length === 0) return [];
  const chunkIds = uniquePositiveIds(
    candidates.map((candidate) => candidate.chunkId)
  );
  if (chunkIds.length === 0) return [];

  const rows = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT chunk.id AS chunk_id
        FROM repository_item_chunks chunk
        JOIN repository_items item ON item.id = chunk.item_id
        JOIN knowledge_repositories repository
          ON repository.id = item.repository_id
        LEFT JOIN repository_item_versions version
          ON version.id = chunk.item_version_id
        WHERE chunk.id IN (${sql.join(
          chunkIds.map((chunkId) => sql`${chunkId}`),
          sql`, `
        )})
          AND item.lifecycle_status = 'active'
          AND repository.lifecycle_status = 'active'
          AND (
            repository.expires_at IS NULL
            OR repository.expires_at > now()
          )
          AND ${repositoryAccessFilter(principal)}
          AND ${currentSegmentAccessFilter(principal)}
          AND (
            (
              chunk.item_version_id IS NULL
              AND chunk.index_generation_id IS NULL
              AND item.processing_status = 'completed'
              AND (repository.metadata->>'systemManaged') IS DISTINCT FROM 'true'
              AND NOT EXISTS (
                SELECT 1
                FROM repository_item_chunks current_chunk
                WHERE current_chunk.item_id = item.id
                  AND current_chunk.item_version_id IS NOT NULL
                  AND current_chunk.index_generation_id =
                    repository.active_index_generation_id
              )
            )
            OR (
              chunk.item_version_id IS NOT NULL
              AND chunk.index_generation_id =
                repository.active_index_generation_id
              AND version.storage_status = 'available'
              AND version.inspection_status IN ('clean', 'not_required')
              AND version.processing_status = 'completed'
            )
          )
      `),
    "retrievalV2.revalidateCandidatesForRerank"
  );
  const allowedChunkIds = new Set(
    (rows as unknown as Array<Record<string, unknown>>).flatMap((row) => {
      const chunkId = positiveInteger(row.chunk_id);
      return chunkId == null ? [] : [chunkId];
    })
  );
  return candidates.filter((candidate) =>
    allowedChunkIds.has(candidate.chunkId)
  );
}

async function expandCandidate(
  candidate: RetrievalCandidate,
  principal: RetrievalPrincipal,
  neighborCount: number
): Promise<RetrievalContextSegment[]> {
  if (candidate.versionNumber === 0) {
    const rows = await executeQuery(
      (db) =>
        db.execute(sql`
          SELECT
            chunk.id AS chunk_id,
            repository.id AS repository_id,
            repository.name AS repository_name,
            item.id AS item_id,
            item.stable_id AS item_stable_id,
            item.name AS item_name,
            chunk.content,
            chunk.chunk_index,
            chunk.modality,
            chunk.source_locator,
            chunk.tokens,
            chunk.metadata,
            0::double precision AS score
          FROM repository_item_chunks chunk
          JOIN repository_items item ON item.id = chunk.item_id
          JOIN knowledge_repositories repository ON repository.id = item.repository_id
          WHERE chunk.id = ${candidate.chunkId}
            AND repository.id = ${candidate.repositoryId}
            AND item.id = ${candidate.itemId}
            AND chunk.item_version_id IS NULL
            AND chunk.index_generation_id IS NULL
            AND item.lifecycle_status = 'active'
            AND item.processing_status = 'completed'
            AND repository.lifecycle_status = 'active'
            AND (
              repository.expires_at IS NULL
              OR repository.expires_at > now()
            )
            AND (repository.metadata->>'systemManaged') IS DISTINCT FROM 'true'
            AND ${repositoryAccessFilter(principal)}
            AND ${currentSegmentAccessFilter(principal)}
            AND NOT EXISTS (
              SELECT 1
              FROM repository_item_chunks current_chunk
              WHERE current_chunk.item_id = item.id
                AND current_chunk.item_version_id IS NOT NULL
                AND current_chunk.index_generation_id = repository.active_index_generation_id
            )
          LIMIT 1
        `),
      "retrievalV2.expandLegacyContext"
    );
    return (rows as unknown as Array<Record<string, unknown>>).flatMap((row) => {
      const rechecked = mapLegacyCandidate(row);
      try {
        return [
          {
            chunkId: rechecked.chunkId,
            chunkIndex: rechecked.chunkIndex,
            content: rechecked.content,
            contextPrefix: rechecked.contextPrefix,
            modality: rechecked.modality,
            tokens: rechecked.tokens,
            citation: resolveRetrievalCitation(rechecked),
          },
        ];
      } catch {
        return [];
      }
    });
  }
  const lower = Math.max(0, candidate.chunkIndex - neighborCount);
  const upper = candidate.chunkIndex + neighborCount;
  const rows = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT ${candidateColumns()}, 0::double precision AS score
        FROM repository_item_chunks chunk
        JOIN repository_items item ON item.id = chunk.item_id
        JOIN repository_item_versions version ON version.id = chunk.item_version_id
        JOIN knowledge_repositories repository ON repository.id = item.repository_id
        WHERE chunk.index_generation_id = ${candidate.generationId}::uuid
          AND chunk.item_version_id = ${candidate.itemVersionId}::uuid
          AND chunk.item_id = ${candidate.itemId}
          AND repository.active_index_generation_id = ${candidate.generationId}::uuid
          AND repository.lifecycle_status = 'active'
          AND (
            repository.expires_at IS NULL
            OR repository.expires_at > now()
          )
          AND (
            chunk.chunk_index BETWEEN ${lower} AND ${upper}
            OR chunk.chunk_index = ${candidate.parentChunkIndex ?? -1}
          )
          AND item.lifecycle_status = 'active'
          AND version.storage_status = 'available'
          AND version.inspection_status IN ('clean', 'not_required')
          AND version.processing_status = 'completed'
          AND ${repositoryAccessFilter(principal)}
          AND ${currentSegmentAccessFilter(principal)}
        ORDER BY chunk.chunk_index
      `),
    "retrievalV2.expandContext"
  );
  const expanded = (rows as unknown as Array<Record<string, unknown>>).flatMap((row) => {
    const contextCandidate = mapCandidate(row, "lexical");
    try {
      return [
        {
          chunkId: contextCandidate.chunkId,
          chunkIndex: contextCandidate.chunkIndex,
          content: contextCandidate.content,
          contextPrefix: contextCandidate.contextPrefix,
          modality: contextCandidate.modality,
          tokens: contextCandidate.tokens,
          citation: resolveRetrievalCitation(contextCandidate),
        },
      ];
    } catch {
      return [];
    }
  });

  // Only a row returned by the final ACL/lifecycle query may become model
  // context. Reconstructing the primary from the pre-check candidate would
  // disclose stale content when access is revoked or the repository expires
  // between candidate discovery and context expansion.
  const primary = expanded.find(
    (segment) => segment.chunkId === candidate.chunkId
  );
  if (!primary) return [];

  const neighbors = expanded
    .filter((segment) => segment.chunkId !== candidate.chunkId)
    .sort((left, right) => {
      const leftIsParent = left.chunkIndex === candidate.parentChunkIndex;
      const rightIsParent = right.chunkIndex === candidate.parentChunkIndex;
      if (leftIsParent !== rightIsParent) return leftIsParent ? -1 : 1;
      const distance =
        Math.abs(left.chunkIndex - candidate.chunkIndex) -
        Math.abs(right.chunkIndex - candidate.chunkIndex);
      return distance || left.chunkIndex - right.chunkIndex;
    });

  return [primary, ...neighbors];
}

function fitContextBudget(
  candidates: RetrievalCandidate[],
  contexts: RetrievalContextSegment[][],
  tokenBudget: number
): RetrievalResult[] {
  const results: RetrievalResult[] = [];
  let remaining = tokenBudget;
  for (const [index, candidate] of candidates.entries()) {
    const recheckedContext = contexts[index] ?? [];
    if (recheckedContext.length === 0) continue;
    const fitted: RetrievalContextSegment[] = [];
    for (const segment of recheckedContext) {
      const segmentTokens = countRepositoryTokens(
        `${segment.contextPrefix}\n${segment.content}`
      );
      if (segmentTokens <= remaining) {
        fitted.push({ ...segment, tokens: segmentTokens });
        remaining -= segmentTokens;
        continue;
      }
      if (remaining >= 64) {
        const marker = "[… truncated to retrieval budget]";
        const markerTokens = countRepositoryTokens(`\n${marker}`);
        const content = truncateToRepositoryTokens(
          `${segment.contextPrefix}\n${segment.content}`,
          Math.max(1, remaining - markerTokens)
        );
        const boundedContent = `${content}\n${marker}`;
        fitted.push({
          ...segment,
          contextPrefix: "",
          content: boundedContent,
          tokens: countRepositoryTokens(boundedContent),
        });
        remaining -= countRepositoryTokens(boundedContent);
      }
      break;
    }
    if (fitted.length === 0) {
      if (remaining < 64) break;
      continue;
    }
    const similarity =
      candidate.rerankScore ??
      candidate.denseScore ??
      candidate.visualScore ??
      candidate.lexicalScore ??
      candidate.fusedScore;
    results.push({
      ...candidate,
      similarity,
      context: fitted,
      citations: fitted.map((segment) => segment.citation),
    });
    if (remaining <= 0) break;
  }
  return results;
}

function uniquePositiveIds(values: number[]): number[] {
  return [...new Set(values)].filter(
    (value) => Number.isSafeInteger(value) && value > 0
  );
}

export async function retrieveRepositoryContent(
  request: RepositoryRetrievalRequest,
  dependencies: RetrievalDependencies = {}
): Promise<RetrievalResponse> {
  const startedAt = Date.now();
  const log = createLogger({ module: "repository-retrieval-v2" });
  const query = request.query.trim();
  if (!query) throw new Error("Retrieval query cannot be empty");
  const repositoryIds = uniquePositiveIds(request.repositoryIds).slice(0, 50);
  const mode = request.mode ?? "hybrid";
  const limit = Math.min(Math.max(1, Math.floor(request.limit ?? 10)), 50);
  const threshold = Math.min(Math.max(0, request.threshold ?? 0.2), 1);
  const denseWeight = Math.min(Math.max(0, request.denseWeight ?? 0.6), 1);
  const modalities = request.modalities?.length
    ? [...new Set(request.modalities)].filter((value) =>
        ALL_MODALITIES.includes(value)
      )
    : ALL_MODALITIES;
  if (modalities.length === 0) {
    throw new Error("Retrieval requires at least one supported modality");
  }
  const config = await getContentPlatformConfig();
  const authorized = await getAccessibleRepositoriesByCognitoSub(
    repositoryIds,
    request.userCognitoSub
  );
  const authorizedIds = authorized
    .filter((repository) => repository.isAccessible)
    .map((repository) => repository.id);
  const principal =
    authorizedIds.length > 0
      ? await resolvePrincipal(request.userCognitoSub)
      : null;
  if (!principal || authorizedIds.length === 0) {
    return {
      results: [],
      diagnostics: {
        durationMs: Date.now() - startedAt,
        repositoriesRequested: repositoryIds.length,
        repositoriesAuthorized: 0,
        denseCandidates: 0,
        lexicalCandidates: 0,
        visualCandidates: 0,
        fusedCandidates: 0,
        reranked: false,
        returnedResults: 0,
        returnedTokens: 0,
      },
    };
  }
  const snapshots = await resolveSnapshots(authorizedIds);
  const candidateLimit = Math.max(limit, config.retrievalCandidateLimit);
  const textEmbedding = dependencies.generateTextEmbedding ?? generateEmbedding;
  const visualEmbedding =
    dependencies.generateVisualEmbedding ?? generateVisualQueryEmbedding;

  const dense: RetrievalCandidate[] = [];
  if (mode !== "keyword") {
    const groups = Map.groupBy(
      snapshots.filter((snapshot) => snapshot.embeddingModel),
      (snapshot) => `${snapshot.embeddingModel}:${snapshot.embeddingDimensions}`
    );
    for (const group of groups.values()) {
      const first = group[0];
      if (!first) continue;
      const descriptor = parseRepositoryEmbeddingDescriptor(
        first.embeddingModel,
        first.embeddingDimensions
      );
      if (!descriptor) continue;
      try {
        const vector = await textEmbedding(query, {
          provider: descriptor.provider,
          modelId: descriptor.modelId,
          dimensions: descriptor.dimensions,
        });
        dense.push(
          ...(await Promise.all(
            group.map((snapshot) =>
              denseCandidates(
                snapshot,
                principal,
                vector,
                modalities,
                candidateLimit,
                threshold
              )
            )
          )).flat()
        );
      } catch (error) {
        log.warn("Dense retrieval unavailable for an embedding generation", {
          descriptor: first.embeddingModel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const lexical =
    mode === "vector"
      ? []
      : (
          await Promise.all(
            snapshots.map((snapshot) =>
              lexicalCandidates(
                snapshot,
                principal,
                query,
                modalities,
                candidateLimit
              )
            )
          )
        ).flat();
  const legacyCompatibility = await legacyCompatibilityCandidates(
    authorizedIds,
    principal,
    query,
    modalities,
    candidateLimit
  );
  lexical.push(...legacyCompatibility);

  const visual: RetrievalCandidate[] = [];
  if (config.visualIndexEnabled && mode !== "keyword") {
    const groups = Map.groupBy(
      snapshots.filter((snapshot) => snapshot.visualEmbeddingModel),
      (snapshot) =>
        `${snapshot.visualEmbeddingModel}:${snapshot.visualEmbeddingDimensions}`
    );
    for (const group of groups.values()) {
      const first = group[0];
      const descriptor = first
        ? parseRepositoryEmbeddingDescriptor(
            first.visualEmbeddingModel,
            first.visualEmbeddingDimensions
          )
        : null;
      if (!first || !descriptor) continue;
      try {
        const vector = await visualEmbedding(
          query,
          descriptor.modelId,
          descriptor.dimensions
        );
        visual.push(
          ...(await Promise.all(
            group.map((snapshot) =>
              visualCandidates(
                snapshot,
                principal,
                vector,
                candidateLimit,
                threshold
              )
            )
          )).flat()
        );
      } catch (error) {
        log.warn("Visual retrieval unavailable; continuing without it", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  let fused = reciprocalRankFusion(
    [
      {
        signal: "dense",
        candidates: dense,
        weight: mode === "hybrid" ? denseWeight : 1,
      },
      {
        signal: "lexical",
        candidates: lexical,
        weight: mode === "hybrid" ? 1 - denseWeight : 1,
      },
      {
        signal: "visual",
        candidates: visual,
        weight: mode === "hybrid" ? denseWeight * 0.8 : 0.8,
      },
    ],
    config.retrievalRrfK
  );
  const rerankEnabled =
    (request.rerank ?? config.retrievalRerankEnabled) && fused.length > 1;
  let reranked = false;
  if (rerankEnabled) {
    try {
      const reranker =
        dependencies.reranker ??
        new BedrockRepositoryReranker(config.retrievalRerankModelId);
      const rerankWindow = fused.slice(0, candidateLimit);
      const rerankRemainder = fused.slice(candidateLimit);
      const disclosureSafeWindow = await revalidateCandidatesForRerank(
        rerankWindow,
        principal
      );
      fused = [...disclosureSafeWindow, ...rerankRemainder];
      if (disclosureSafeWindow.length > 1) {
        const scores = await reranker.rerank(
          query,
          disclosureSafeWindow.map((candidate) => ({
            text: [candidate.contextPrefix, candidate.content]
              .filter(Boolean)
              .join("\n"),
          })),
          disclosureSafeWindow.length
        );
        if (scores.length > 0) {
          fused = [
            ...applyRerankScores(disclosureSafeWindow, scores),
            ...rerankRemainder,
          ];
          reranked = true;
        }
      }
    } catch (error) {
      log.warn("Bedrock reranking unavailable; using reciprocal-rank fusion", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const selected = diversifyBySource(
    fused,
    limit,
    config.retrievalMaxPerSource
  );
  const contexts = await Promise.all(
    selected.map((candidate) =>
      expandCandidate(candidate, principal, config.retrievalNeighborCount)
    )
  );
  const tokenBudget = Math.min(
    Math.max(100, request.tokenBudget ?? config.retrievalContextTokens),
    32_000
  );
  const results = fitContextBudget(selected, contexts, tokenBudget);
  const returnedTokens = results.reduce(
    (total, result) =>
      total + result.context.reduce((sum, segment) => sum + segment.tokens, 0),
    0
  );
  return {
    results,
    diagnostics: {
      durationMs: Date.now() - startedAt,
      repositoriesRequested: repositoryIds.length,
      repositoriesAuthorized: authorizedIds.length,
      denseCandidates: dense.length,
      lexicalCandidates: lexical.length,
      visualCandidates: visual.length,
      fusedCandidates: fused.length,
      reranked,
      ...(reranked ? { rerankModelId: config.retrievalRerankModelId } : {}),
      returnedResults: results.length,
      returnedTokens,
    },
  };
}
