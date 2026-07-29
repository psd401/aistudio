/* eslint-disable no-var */
var mockExecuteTransaction = jest.fn()
var mockExecuteQuery = jest.fn()
var mockToPgRows = jest.fn()
/* eslint-enable no-var */

jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: (...args: unknown[]) => mockExecuteTransaction(...args),
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  toPgRows: (...args: unknown[]) => mockToPgRows(...args),
}))

import {
  drizzleMemoryRepository,
  shouldUpdateSimilarMemory,
  type StoredNexusMemory,
} from "@/lib/nexus/memory/memory-repository"
import { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"

const MEMORY: StoredNexusMemory = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: 7,
  content: "Prefers short answers",
  category: "preference",
  source: "tool",
  sourceConversationId: null,
  createdAt: new Date("2026-07-27T12:00:00.000Z"),
  updatedAt: new Date("2026-07-27T12:00:00.000Z"),
}

function transactionDouble() {
  const updateReturning = jest.fn().mockResolvedValue([MEMORY])
  const updateWhere = jest.fn(() => ({ returning: updateReturning }))
  const updateSet = jest.fn((_values: unknown) => ({
    where: updateWhere,
  }))
  const insertReturning = jest.fn().mockResolvedValue([MEMORY])
  const insertValues = jest.fn(() => ({ returning: insertReturning }))
  return {
    execute: jest.fn().mockResolvedValue({}),
    update: jest.fn(() => ({ set: updateSet })),
    insert: jest.fn(() => ({ values: insertValues })),
    updateSet,
  }
}

describe("Nexus memory repository deduplication", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("treats similarity >= 0.90 as an update and lower similarity as an insert", () => {
    expect(shouldUpdateSimilarMemory(0.9, 0.9)).toBe(true)
    expect(shouldUpdateSimilarMemory("0.9501", 0.9)).toBe(true)
    expect(shouldUpdateSimilarMemory(0.8999, 0.9)).toBe(false)
    expect(shouldUpdateSimilarMemory(undefined, 0.9)).toBe(false)
  })

  it("updates the nearest live memory at the threshold", async () => {
    const tx = transactionDouble()
    mockToPgRows.mockReturnValue([
      { id: MEMORY.id, similarity: "0.9000" },
    ])
    mockExecuteTransaction.mockImplementation(
      async (operation: (value: typeof tx) => Promise<unknown>) =>
        operation(tx),
    )

    await expect(
      drizzleMemoryRepository.saveWithDedup(
        {
          userId: 7,
          content: "Prefers concise answers",
          category: "preference",
          source: "tool",
          embedding: [0.1, 0.2],
        },
        0.9,
      ),
    ).resolves.toEqual({ memory: MEMORY, action: "updated" })
    expect(tx.update).toHaveBeenCalledTimes(1)
    expect(tx.insert).not.toHaveBeenCalled()
  })

  it("inserts when the nearest live memory is below the threshold", async () => {
    const tx = transactionDouble()
    mockToPgRows.mockReturnValue([
      { id: MEMORY.id, similarity: 0.8999 },
    ])
    mockExecuteTransaction.mockImplementation(
      async (operation: (value: typeof tx) => Promise<unknown>) =>
        operation(tx),
    )

    await expect(
      drizzleMemoryRepository.saveWithDedup(
        {
          userId: 7,
          content: "Works on a new project",
          category: "context",
          source: "tool",
          embedding: [0.4, 0.6],
        },
        0.9,
      ),
    ).resolves.toEqual({ memory: MEMORY, action: "inserted" })
    expect(tx.insert).toHaveBeenCalledTimes(1)
    expect(tx.update).not.toHaveBeenCalled()
  })

  it("serializes the dedup decision per user before querying for a match", async () => {
    const tx = transactionDouble()
    mockToPgRows.mockReturnValue([])
    mockExecuteTransaction.mockImplementation(
      async (operation: (value: typeof tx) => Promise<unknown>) =>
        operation(tx),
    )

    await drizzleMemoryRepository.saveWithDedup(
      {
        userId: 7,
        content: "Prefers concise answers",
        category: "preference",
        source: "tool",
        embedding: [0.1, 0.2],
      },
      0.9,
    )

    expect(tx.execute).toHaveBeenCalledTimes(2)
    const lockStatement = tx.execute.mock.calls[0]?.[0]
    if (!(lockStatement instanceof SQL)) {
      throw new TypeError("Expected the first transaction statement to be SQL")
    }
    const renderedLock = new PgDialect().sqlToQuery(lockStatement)
    expect(renderedLock.sql).toContain("pg_advisory_xact_lock")
    expect(renderedLock.params).toContain(7)

    const nearestStatement = tx.execute.mock.calls[1]?.[0]
    if (!(nearestStatement instanceof SQL)) {
      throw new TypeError("Expected the second transaction statement to be SQL")
    }
    const renderedNearest = new PgDialect().sqlToQuery(nearestStatement)
    expect(renderedNearest.sql).toContain("AS MATERIALIZED")
    expect(renderedNearest.sql).toContain("FOR UPDATE")
    expect(mockExecuteTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      "saveNexusUserMemory",
      { isolationLevel: "read committed" },
    )
  })

  it("excludes loaded profiles from the exact owner subset before ranking", async () => {
    const execute = jest.fn().mockResolvedValue({})
    mockExecuteQuery.mockImplementation(
      async (operation: (value: { execute: typeof execute }) => unknown) =>
        operation({ execute }),
    )
    mockToPgRows.mockReturnValue([])

    await drizzleMemoryRepository.findRelevantMemories(
      7,
      [0.1, 0.2],
      0.3,
      6,
      [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ],
    )

    const statement = execute.mock.calls[0]?.[0]
    if (!(statement instanceof SQL)) {
      throw new TypeError("Expected the relevant-memory query to be SQL")
    }
    const rendered = new PgDialect().sqlToQuery(statement)
    expect(rendered.sql).toContain("AS MATERIALIZED")
    expect(rendered.sql).toContain("FROM owner_memories")
    expect(rendered.sql).toContain("'profile', 'preference', 'context'")
    expect(rendered.sql).toContain("id NOT IN")
    expect(rendered.sql.indexOf("id NOT IN")).toBeLessThan(
      rendered.sql.indexOf("LIMIT"),
    )
    expect(rendered.params).toContain(7)
    expect(rendered.params).toContain(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    )
    expect(rendered.params).toContain(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    )
  })
})

describe("Nexus automatic memory deduplication", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("stays inside its category without replacing provenance", async () => {
    const tx = transactionDouble()
    mockToPgRows.mockReturnValue([
      { id: MEMORY.id, similarity: "0.9500" },
    ])
    mockExecuteTransaction.mockImplementation(
      async (operation: (value: typeof tx) => Promise<unknown>) =>
        operation(tx),
    )

    await drizzleMemoryRepository.saveWithDedup(
      {
        userId: 7,
        content: "Prefers concise explanations",
        category: "preference",
        source: "auto",
        sourceConversationId:
          "22222222-2222-4222-8222-222222222222",
        embedding: [0.1, 0.2],
      },
      0.9,
    )

    const nearestStatement = tx.execute.mock.calls[1]?.[0]
    if (!(nearestStatement instanceof SQL)) {
      throw new TypeError("Expected the nearest-memory query to be SQL")
    }
    const renderedNearest = new PgDialect().sqlToQuery(nearestStatement)
    expect(renderedNearest.sql).toContain("category =")
    expect(renderedNearest.params).toContain("preference")
    expect(tx.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Prefers concise explanations",
        embedding: [0.1, 0.2],
      }),
    )
    const updateRecord = tx.updateSet.mock.calls[0]?.[0]
    expect(updateRecord).not.toHaveProperty("category")
    expect(updateRecord).not.toHaveProperty("source")
    expect(updateRecord).not.toHaveProperty("sourceConversationId")
  })
})

describe("Nexus memory consolidation-neighbor search", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("ranks consolidation neighbors inside the live owner subset and maps similarity", async () => {
    const execute = jest.fn().mockResolvedValue({})
    mockExecuteQuery.mockImplementation(
      async (operation: (value: { execute: typeof execute }) => unknown) =>
        operation({ execute }),
    )
    mockToPgRows.mockReturnValue([
      {
        id: MEMORY.id,
        user_id: 7,
        content: MEMORY.content,
        category: MEMORY.category,
        source: MEMORY.source,
        source_conversation_id: null,
        created_at: MEMORY.createdAt,
        updated_at: MEMORY.updatedAt,
        similarity: "0.9312",
      },
    ])

    await expect(
      drizzleMemoryRepository.findSimilarMemories(
        7,
        [0.1, 0.2],
        5,
      ),
    ).resolves.toEqual([{ ...MEMORY, similarity: 0.9312 }])

    const statement = execute.mock.calls[0]?.[0]
    if (!(statement instanceof SQL)) {
      throw new TypeError("Expected the consolidation-neighbor query to be SQL")
    }
    const rendered = new PgDialect().sqlToQuery(statement)
    expect(rendered.sql).toContain("AS MATERIALIZED")
    expect(rendered.sql).toContain("user_id =")
    expect(rendered.sql).toContain("deleted_at IS NULL")
    expect(rendered.sql).toContain("AS similarity")
    expect(rendered.sql).toContain("ORDER BY embedding")
    expect(rendered.params).toContain(7)
    expect(rendered.params).toContain(5)
  })
})
