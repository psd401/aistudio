import {
  deriveRepositoryReadiness,
  isRepositorySearchable,
} from "@/lib/repositories/readiness-service"

function row(
  overrides: Partial<Parameters<typeof deriveRepositoryReadiness>[0]> = {}
): Parameters<typeof deriveRepositoryReadiness>[0] {
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
})
