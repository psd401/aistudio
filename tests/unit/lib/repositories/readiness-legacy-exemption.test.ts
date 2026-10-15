/**
 * Legacy keyword-searchable exemption from the repository readiness gate.
 *
 * A repository written while content dual-write was off has only legacy chunks
 * and no active generation, so readiness calls it `failed`. That is right for
 * callers that disable legacy compatibility, but `repositories_search` retrieves
 * those chunks, so it may exempt exactly these repositories — and nothing else.
 */
import {
  assertRepositoriesSearchable,
  selectLegacyKeywordSearchableRepositoryIds,
} from "@/lib/repositories/readiness-service"
import { readinessRow } from "./readiness-fixtures"

const mockExecuteQuery = jest.fn()
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  toPgRows: (value: unknown) => value,
}))

/** Active items, nothing pending/failed, no generation → readiness `failed`. */
const legacyOnly = readinessRow({ repository_id: 7, active_item_count: 2 })

function compiledSql(callIndex: number): string {
  const build = mockExecuteQuery.mock.calls[callIndex][0] as (db: {
    execute: (query: unknown) => unknown
  }) => unknown
  let captured: unknown
  build({
    execute: (query) => {
      captured = query
      return []
    },
  })
  return JSON.stringify(captured)
}

describe("legacy keyword-searchable readiness exemption", () => {
  beforeEach(() => {
    mockExecuteQuery.mockReset()
  })

  it("blocks a legacy-only repository when no exemption is passed", async () => {
    mockExecuteQuery.mockResolvedValueOnce([legacyOnly])

    await expect(assertRepositoriesSearchable([7])).rejects.toMatchObject({
      code: "REPOSITORY_NOT_READY",
    })
  })

  it("lets an exempted legacy-only repository through", async () => {
    mockExecuteQuery.mockResolvedValueOnce([legacyOnly])

    await expect(
      assertRepositoriesSearchable([7], {
        legacyKeywordSearchableIds: new Set([7]),
      })
    ).resolves.toEqual([
      expect.objectContaining({ repositoryId: 7, readiness: "failed" }),
    ])
  })

  it("never exempts a repository that is processing, even if listed", async () => {
    mockExecuteQuery.mockResolvedValueOnce([
      readinessRow({
        repository_id: 7,
        active_item_count: 2,
        pending_item_count: 1,
      }),
    ])

    await expect(
      assertRepositoriesSearchable([7], {
        legacyKeywordSearchableIds: new Set([7]),
      })
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_READY" })
  })

  it("still blocks a non-exempted failed repository alongside an exempted one", async () => {
    mockExecuteQuery.mockResolvedValueOnce([
      legacyOnly,
      readinessRow({ repository_id: 8, active_item_count: 1, failed_item_count: 1 }),
    ])

    await expect(
      assertRepositoriesSearchable([7, 8], {
        legacyKeywordSearchableIds: new Set([7]),
      })
    ).rejects.toMatchObject({
      code: "REPOSITORY_NOT_READY",
      repositories: [expect.objectContaining({ repositoryId: 8 })],
    })
  })

  it("selects only repositories with legacy chunks, no generation and nothing pending or failed", async () => {
    mockExecuteQuery.mockResolvedValueOnce([{ repository_id: 7 }])

    await expect(
      selectLegacyKeywordSearchableRepositoryIds([7, 7, 8, -1])
    ).resolves.toEqual(new Set([7]))

    const query = compiledSql(0)
    expect(query).toContain("active_index_generation_id IS NULL")
    expect(query).toContain("chunk.item_version_id IS NULL")
    expect(query).toContain("chunk.index_generation_id IS NULL")
    expect(query).toContain("'failed'")
    expect(query).toContain("'embedding_failed'")
    expect(query).toContain("generation.status IN ('building', 'failed')")
  })

  it("does not query for an empty or invalid id list", async () => {
    await expect(
      selectLegacyKeywordSearchableRepositoryIds([0, -3])
    ).resolves.toEqual(new Set())
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })
})
