import { sql } from "drizzle-orm"
import { executeQuery, toPgRows } from "@/lib/db/drizzle-client"

export const REPOSITORY_READINESS_STATES = [
  "empty",
  "processing",
  "searchable",
  "degraded",
  "disconnected",
  "failed",
] as const

export type RepositoryReadiness =
  (typeof REPOSITORY_READINESS_STATES)[number]

export type RepositoryReadinessErrorCode =
  | "REPOSITORY_NOT_READY"
  | "REPOSITORY_DISCONNECTED"
  | "REPOSITORY_BINDING_INACCESSIBLE"

export interface RepositoryReadinessSnapshot {
  repositoryId: number
  readiness: RepositoryReadiness
  activeGenerationId: string | null
  indexedItemCount: number
  segmentCount: number
  lastIndexError: string | null
}

interface RepositoryReadinessRow {
  repository_id: number
  lifecycle_status: string
  active_generation_id: string | null
  active_generation_status: string | null
  active_item_count: number
  indexed_item_count: number
  segment_count: number
  pending_item_count: number
  failed_item_count: number
  unavailable_item_count: number
  building_generation_count: number
  failed_generation_count: number
  last_item_error: string | null
  last_generation_error: string | null
  connector_count: number
  revoked_connector_count: number
  degraded_connector_count: number
  last_connector_error: string | null
}

export class RepositoryReadinessError extends Error {
  constructor(
    readonly code: RepositoryReadinessErrorCode,
    message: string,
    readonly repositories: RepositoryReadinessSnapshot[]
  ) {
    super(message)
    this.name = "RepositoryReadinessError"
  }
}

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

// eslint-disable-next-line complexity -- Readiness precedence is an explicit fail-closed state machine over canonical lifecycle evidence.
export function deriveRepositoryReadiness(
  row: RepositoryReadinessRow
): RepositoryReadinessSnapshot {
  const activeItemCount = numberValue(row.active_item_count)
  const indexedItemCount = numberValue(row.indexed_item_count)
  const segmentCount = numberValue(row.segment_count)
  const pendingItemCount = numberValue(row.pending_item_count)
  const failedItemCount = numberValue(row.failed_item_count)
  const unavailableItemCount = numberValue(row.unavailable_item_count)
  const buildingGenerationCount = numberValue(row.building_generation_count)
  const failedGenerationCount = numberValue(row.failed_generation_count)
  const connectorCount = numberValue(row.connector_count)
  const revokedConnectorCount = numberValue(row.revoked_connector_count)
  const degradedConnectorCount = numberValue(row.degraded_connector_count)
  const hasSearchableSnapshot =
    row.active_generation_id !== null &&
    row.active_generation_status === "active" &&
    indexedItemCount > 0 &&
    segmentCount > 0
  const allConnectorsRevoked =
    connectorCount > 0 && revokedConnectorCount === connectorCount
  const disconnected =
    allConnectorsRevoked &&
    (activeItemCount === 0 || unavailableItemCount > 0)
  const hasDegradation =
    failedItemCount > 0 ||
    unavailableItemCount > 0 ||
    failedGenerationCount > 0 ||
    degradedConnectorCount > 0

  let readiness: RepositoryReadiness
  if (row.lifecycle_status !== "active") {
    readiness = "failed"
  } else if (disconnected) {
    readiness = "disconnected"
  } else if (hasSearchableSnapshot) {
    readiness = hasDegradation ? "degraded" : "searchable"
  } else if (buildingGenerationCount > 0 || pendingItemCount > 0) {
    readiness = "processing"
  } else if (
    activeItemCount > 0 ||
    failedItemCount > 0 ||
    failedGenerationCount > 0
  ) {
    readiness = "failed"
  } else {
    readiness = "empty"
  }

  return {
    repositoryId: Number(row.repository_id),
    readiness,
    activeGenerationId: row.active_generation_id,
    indexedItemCount,
    segmentCount,
    lastIndexError:
      row.last_generation_error ??
      row.last_item_error ??
      row.last_connector_error ??
      null,
  }
}

export function isRepositorySearchable(
  snapshot: RepositoryReadinessSnapshot
): boolean {
  return (
    snapshot.readiness === "searchable" ||
    snapshot.readiness === "degraded"
  )
}

// eslint-disable-next-line max-lines-per-function -- One query derives all readiness evidence from a single PostgreSQL snapshot.
export async function getRepositoryReadiness(
  repositoryIds: number[]
): Promise<Map<number, RepositoryReadinessSnapshot>> {
  const ids = [...new Set(repositoryIds)].filter(
    (id) => Number.isSafeInteger(id) && id > 0
  )
  if (ids.length === 0) return new Map()
  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT
          repository.id::integer AS repository_id,
          repository.lifecycle_status,
          repository.active_index_generation_id::text AS active_generation_id,
          (
            SELECT generation.status
            FROM repository_index_generations generation
            WHERE generation.id = repository.active_index_generation_id
            LIMIT 1
          ) AS active_generation_status,
          (
            SELECT count(*)::integer
            FROM repository_items item
            WHERE item.repository_id = repository.id
              AND item.lifecycle_status = 'active'
          ) AS active_item_count,
          (
            SELECT count(DISTINCT chunk.item_id)::integer
            FROM repository_item_chunks chunk
            JOIN repository_items item ON item.id = chunk.item_id
            JOIN repository_item_versions version
              ON version.id = chunk.item_version_id
            WHERE chunk.index_generation_id =
              repository.active_index_generation_id
              AND item.repository_id = repository.id
              AND item.lifecycle_status = 'active'
              AND item.current_version_id = version.id
              AND version.storage_status = 'available'
              AND version.inspection_status IN ('clean', 'not_required')
              AND version.processing_status = 'completed'
          ) AS indexed_item_count,
          (
            SELECT count(*)::integer
            FROM repository_item_chunks chunk
            JOIN repository_items item ON item.id = chunk.item_id
            JOIN repository_item_versions version
              ON version.id = chunk.item_version_id
            WHERE chunk.index_generation_id =
              repository.active_index_generation_id
              AND item.repository_id = repository.id
              AND item.lifecycle_status = 'active'
              AND item.current_version_id = version.id
              AND version.storage_status = 'available'
              AND version.inspection_status IN ('clean', 'not_required')
              AND version.processing_status = 'completed'
          ) AS segment_count,
          (
            SELECT count(*)::integer
            FROM repository_items item
            LEFT JOIN repository_item_versions version
              ON version.id = item.current_version_id
            WHERE item.repository_id = repository.id
              AND item.lifecycle_status = 'active'
              AND (
                item.processing_status IN (
                  'pending',
                  'processing',
                  'processing_ocr',
                  'processing_embeddings'
                )
                OR version.processing_status IN ('pending', 'processing')
              )
          ) AS pending_item_count,
          (
            SELECT count(*)::integer
            FROM repository_items item
            LEFT JOIN repository_item_versions version
              ON version.id = item.current_version_id
            WHERE item.repository_id = repository.id
              AND item.lifecycle_status = 'active'
              AND (
                item.processing_status IN ('failed', 'embedding_failed')
                OR version.processing_status = 'failed'
                OR version.inspection_status IN ('blocked', 'error')
              )
          ) AS failed_item_count,
          (
            SELECT count(*)::integer
            FROM repository_items item
            WHERE item.repository_id = repository.id
              AND item.lifecycle_status = 'unavailable'
          ) AS unavailable_item_count,
          (
            SELECT count(*)::integer
            FROM repository_index_generations generation
            WHERE generation.repository_id = repository.id
              AND generation.status = 'building'
          ) AS building_generation_count,
          (
            SELECT count(*)::integer
            FROM repository_index_generations generation
            WHERE generation.repository_id = repository.id
              AND generation.status = 'failed'
          ) AS failed_generation_count,
          (
            SELECT item.processing_error
            FROM repository_items item
            WHERE item.repository_id = repository.id
              AND item.processing_error IS NOT NULL
            ORDER BY item.updated_at DESC
            LIMIT 1
          ) AS last_item_error,
          (
            SELECT generation.error_message
            FROM repository_index_generations generation
            WHERE generation.repository_id = repository.id
              AND generation.status = 'failed'
            ORDER BY generation.created_at DESC
            LIMIT 1
          ) AS last_generation_error,
          (
            SELECT count(*)::integer
            FROM repository_connectors connector
            WHERE connector.repository_id = repository.id
          ) AS connector_count,
          (
            SELECT count(*)::integer
            FROM repository_connectors connector
            WHERE connector.repository_id = repository.id
              AND connector.status = 'revoked'
          ) AS revoked_connector_count,
          (
            SELECT count(*)::integer
            FROM repository_connectors connector
            WHERE connector.repository_id = repository.id
              AND connector.status = 'degraded'
          ) AS degraded_connector_count,
          (
            SELECT connector.last_error_message
            FROM repository_connectors connector
            WHERE connector.repository_id = repository.id
              AND connector.last_error_message IS NOT NULL
            ORDER BY connector.updated_at DESC
            LIMIT 1
          ) AS last_connector_error
        FROM knowledge_repositories repository
        WHERE repository.id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `
        )})
      `),
    "repositoryReadiness.load"
  )
  const rows = toPgRows<RepositoryReadinessRow>(result)
  return new Map(
    rows.map((row) => {
      const snapshot = deriveRepositoryReadiness(row)
      return [snapshot.repositoryId, snapshot]
    })
  )
}

export async function assertRepositoriesSearchable(
  repositoryIds: number[]
): Promise<RepositoryReadinessSnapshot[]> {
  const ids = [...new Set(repositoryIds)]
  const readiness = await getRepositoryReadiness(ids)
  const missingIds = ids.filter((id) => !readiness.has(id))
  if (missingIds.length > 0) {
    throw new RepositoryReadinessError(
      "REPOSITORY_BINDING_INACCESSIBLE",
      "One or more repository bindings no longer exist or are inaccessible",
      []
    )
  }
  const snapshots = ids.flatMap((id) => {
    const snapshot = readiness.get(id)
    return snapshot ? [snapshot] : []
  })
  const disconnected = snapshots.filter(
    (snapshot) => snapshot.readiness === "disconnected"
  )
  if (disconnected.length > 0) {
    throw new RepositoryReadinessError(
      "REPOSITORY_DISCONNECTED",
      "A bound repository is disconnected and has no searchable content",
      disconnected
    )
  }
  const notReady = snapshots.filter(
    (snapshot) => !isRepositorySearchable(snapshot)
  )
  if (notReady.length > 0) {
    throw new RepositoryReadinessError(
      "REPOSITORY_NOT_READY",
      "A bound repository is not ready for search",
      notReady
    )
  }
  return snapshots
}
