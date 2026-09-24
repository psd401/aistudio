import { deriveRepositoryReadiness } from "@/lib/repositories/readiness-service"

/**
 * One raw readiness row, typed from the production signature so a renamed or
 * added readiness column fails to compile in every test that builds rows.
 */
export type ReadinessRow = Parameters<typeof deriveRepositoryReadiness>[0]

/** An active, intentionally empty repository unless overridden. */
export function readinessRow(overrides: Partial<ReadinessRow> = {}): ReadinessRow {
  return {
    repository_id: 39,
    lifecycle_status: "active",
    active_generation_id: null,
    active_generation_status: null,
    active_item_count: 0,
    indexed_item_count: 0,
    segment_count: 0,
    pending_item_count: 0,
    failed_item_count: 0,
    unavailable_item_count: 0,
    building_generation_count: 0,
    failed_generation_count: 0,
    last_item_error: null,
    last_generation_error: null,
    connector_count: 0,
    revoked_connector_count: 0,
    degraded_connector_count: 0,
    last_connector_error: null,
    ...overrides,
  }
}
