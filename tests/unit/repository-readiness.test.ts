import {
  blocksRepositorySearch,
  deriveRepositoryReadiness,
  isRepositorySearchable,
  selectSearchableRepositoryIds,
} from "@/lib/repositories/readiness-service"
import { readinessRow as row } from "./lib/repositories/readiness-fixtures"

describe("repository readiness", () => {
  it("requires a complete active snapshot to be searchable", () => {
    const readiness = deriveRepositoryReadiness(
      row({
        active_generation_id: "49095154-b9e7-49e2-a707-ac8454e364cf",
        active_generation_status: "active",
        active_item_count: 7,
        indexed_item_count: 7,
        segment_count: 926,
      })
    )
    expect(readiness.readiness).toBe("searchable")
    expect(isRepositorySearchable(readiness)).toBe(true)
  })

  it("distinguishes processing from an empty repository", () => {
    expect(
      deriveRepositoryReadiness(
        row({ active_item_count: 1, building_generation_count: 1 })
      ).readiness
    ).toBe("processing")
    expect(deriveRepositoryReadiness(row()).readiness).toBe("empty")
  })

  it("fails closed when the serving pointer does not reference an active generation", () => {
    expect(
      deriveRepositoryReadiness(
        row({
          active_generation_id: "49095154-b9e7-49e2-a707-ac8454e364cf",
          active_generation_status: "superseded",
          active_item_count: 7,
          indexed_item_count: 7,
          segment_count: 926,
        })
      ).readiness
    ).toBe("failed")
    expect(
      deriveRepositoryReadiness(row({ active_item_count: 7 })).readiness
    ).toBe("failed")
  })

  it("marks revoked connector content disconnected instead of healthy", () => {
    const readiness = deriveRepositoryReadiness(
      row({
        unavailable_item_count: 7,
        connector_count: 1,
        revoked_connector_count: 1,
        last_connector_error: "OAuth token revoked",
      })
    )
    expect(readiness.readiness).toBe("disconnected")
    expect(readiness.lastIndexError).toBe("OAuth token revoked")
  })

  it("keeps a searchable snapshot visible while reporting degradation", () => {
    const readiness = deriveRepositoryReadiness(
      row({
        active_generation_id: "49095154-b9e7-49e2-a707-ac8454e364cf",
        active_generation_status: "active",
        active_item_count: 7,
        indexed_item_count: 6,
        segment_count: 900,
        failed_item_count: 1,
        last_generation_error: "One source failed",
      })
    )
    expect(readiness.readiness).toBe("degraded")
    expect(isRepositorySearchable(readiness)).toBe(true)
  })

  it("does not block a turn on an intentionally empty repository (#1733)", () => {
    const empty = deriveRepositoryReadiness(row())
    expect(empty.readiness).toBe("empty")
    expect(isRepositorySearchable(empty)).toBe(false)
    expect(blocksRepositorySearch(empty)).toBe(false)
  })

  it("treats a zero-item repository with a degraded connector as failed, not empty", () => {
    const failedSync = deriveRepositoryReadiness(
      row({
        connector_count: 1,
        degraded_connector_count: 1,
        last_connector_error: "Drive sync failed",
      })
    )
    expect(failedSync.readiness).toBe("failed")
    expect(failedSync.lastIndexError).toBe("Drive sync failed")
    expect(blocksRepositorySearch(failedSync)).toBe(true)
  })

  it("reports a fully taken-down repository as unavailable, not empty", () => {
    const takenDown = deriveRepositoryReadiness(
      row({ unavailable_item_count: 3 })
    )
    expect(takenDown.readiness).toBe("unavailable")
    expect(isRepositorySearchable(takenDown)).toBe(false)
    expect(blocksRepositorySearch(takenDown)).toBe(true)
  })

  it("keeps a revoked-connector takedown disconnected rather than unavailable", () => {
    expect(
      deriveRepositoryReadiness(
        row({
          unavailable_item_count: 3,
          connector_count: 2,
          revoked_connector_count: 2,
        })
      ).readiness
    ).toBe("disconnected")
    expect(
      deriveRepositoryReadiness(
        row({
          unavailable_item_count: 3,
          connector_count: 2,
          revoked_connector_count: 1,
        })
      ).readiness
    ).toBe("unavailable")
  })

  it("still blocks on processing, failed and disconnected repositories", () => {
    const processing = deriveRepositoryReadiness(
      row({ active_item_count: 1, building_generation_count: 1 })
    )
    const failed = deriveRepositoryReadiness(row({ active_item_count: 7 }))
    const disconnected = deriveRepositoryReadiness(
      row({
        unavailable_item_count: 7,
        connector_count: 1,
        revoked_connector_count: 1,
      })
    )
    expect(blocksRepositorySearch(processing)).toBe(true)
    expect(blocksRepositorySearch(failed)).toBe(true)
    expect(blocksRepositorySearch(disconnected)).toBe(true)
  })

  it("scopes retrieval to repositories that can serve results", () => {
    const empty = deriveRepositoryReadiness(row({ repository_id: 11 }))
    const ready = deriveRepositoryReadiness(
      row({
        repository_id: 12,
        active_generation_id: "49095154-b9e7-49e2-a707-ac8454e364cf",
        active_generation_status: "active",
        active_item_count: 7,
        indexed_item_count: 7,
        segment_count: 926,
      })
    )
    expect(selectSearchableRepositoryIds([empty, ready])).toEqual([12])
    expect(selectSearchableRepositoryIds([empty])).toEqual([])
  })
})
