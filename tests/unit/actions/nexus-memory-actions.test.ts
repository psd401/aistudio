/* eslint-disable no-var */
var mockGetServerSession = jest.fn()
var mockHasCapabilityAccess = jest.fn()
var mockGetUserId = jest.fn()
var mockExecuteQuery = jest.fn()
var mockExecuteTransaction = jest.fn()
var mockSave = jest.fn()
var mockUpdate = jest.fn()
var mockForget = jest.fn()
var mockIsNexusMemoryGloballyEnabled = jest.fn()
var mockIsNexusMemoryEnabledForUser = jest.fn()
var mockMergeNexusUserSettings = jest.fn()
var mockRevalidatePath = jest.fn()
/* eslint-enable no-var */

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))

jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...args: unknown[]) => mockHasCapabilityAccess(...args),
}))

jest.mock("@/lib/db/drizzle", () => ({
  getUserIdByCognitoSubAsNumber: (...args: unknown[]) => mockGetUserId(...args),
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  executeTransaction: (...args: unknown[]) => mockExecuteTransaction(...args),
}))

jest.mock("@/lib/nexus/memory/memory-service", () => ({
  memoryService: {
    save: (...args: unknown[]) => mockSave(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    forget: (...args: unknown[]) => mockForget(...args),
  },
}))

jest.mock("@/lib/nexus/memory/memory-availability", () => ({
  isNexusMemoryGloballyEnabled: (...args: unknown[]) =>
    mockIsNexusMemoryGloballyEnabled(...args),
  isNexusMemoryEnabledForUser: (...args: unknown[]) =>
    mockIsNexusMemoryEnabledForUser(...args),
}))

jest.mock("@/lib/nexus/user-settings", () => ({
  mergeNexusUserSettings: (...args: unknown[]) =>
    mockMergeNexusUserSettings(...args),
}))

jest.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "request-1",
  startTimer: () => jest.fn(),
  sanitizeForLogging: (value: unknown) => value,
  getLogContext: () => ({}),
}))

import {
  addNexusMemory,
  bulkDeleteNexusMemories,
  deleteNexusMemory,
  listNexusMemories,
  setNexusMemoryEnabled,
  updateNexusMemory,
} from "@/actions/nexus/memory.actions"

const MEMORY_ID = "11111111-1111-4111-8111-111111111111"
const FOREIGN_MEMORY_ID = "22222222-2222-4222-8222-222222222222"
const invalidMutationCases: ReadonlyArray<
  readonly [string, () => Promise<unknown>]
> = [
  ["add", () => addNexusMemory({ content: "", category: "context" })],
  [
    "update",
    () =>
      updateNexusMemory({
        memoryId: "invalid",
        content: "",
        category: "context",
      }),
  ],
  ["delete", () => deleteNexusMemory("invalid")],
  ["bulk delete", () => bulkDeleteNexusMemories([])],
]

interface BulkMemoryRow {
  id: string
  userId: number
}

interface BulkTransactionDouble {
  select: jest.Mock
  update: jest.Mock
}

function useBulkTransaction(
  rows: BulkMemoryRow[],
  deletedIds = rows.map((row) => row.id),
): BulkTransactionDouble {
  const lockRows = jest.fn().mockResolvedValue(rows)
  const selectWhere = jest.fn(() => ({ for: lockRows }))
  const from = jest.fn(() => ({ where: selectWhere }))
  const select = jest.fn(() => ({ from }))
  const returning = jest
    .fn()
    .mockResolvedValue(deletedIds.map((id) => ({ id })))
  const updateWhere = jest.fn(() => ({ returning }))
  const set = jest.fn(() => ({ where: updateWhere }))
  const update = jest.fn(() => ({ set }))
  const transaction = { select, update }
  mockExecuteTransaction.mockImplementationOnce(
    (operation: (tx: BulkTransactionDouble) => Promise<unknown>) =>
      operation(transaction),
  )
  return transaction
}

function resetMemoryActionMocks() {
  jest.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ sub: "cognito-sub" })
  mockHasCapabilityAccess.mockResolvedValue(true)
  mockGetUserId.mockResolvedValue(7)
  mockIsNexusMemoryGloballyEnabled.mockResolvedValue(true)
  mockIsNexusMemoryEnabledForUser.mockResolvedValue(true)
  mockMergeNexusUserSettings.mockResolvedValue({
    memoryEnabled: false,
  })
}

describe("Nexus memory settings action authorization", () => {
  beforeEach(resetMemoryActionMocks)

  it.each([
    ["list", () => listNexusMemories()],
    [
      "add",
      () =>
        addNexusMemory({
          content: "Prefers concise answers",
          category: "preference",
        }),
    ],
    [
      "update",
      () =>
        updateNexusMemory({
          memoryId: MEMORY_ID,
          content: "Prefers concise answers",
          category: "preference",
        }),
    ],
    ["delete", () => deleteNexusMemory(MEMORY_ID)],
    ["bulk delete", () => bulkDeleteNexusMemories([MEMORY_ID])],
    ["toggle", () => setNexusMemoryEnabled(false)],
  ])(
    "rejects the %s action without nexus-memory capability",
    async (_name, action) => {
      mockHasCapabilityAccess.mockResolvedValue(false)

      await expect(action()).resolves.toMatchObject({ isSuccess: false })
      expect(mockExecuteQuery).not.toHaveBeenCalled()
      expect(mockSave).not.toHaveBeenCalled()
      expect(mockUpdate).not.toHaveBeenCalled()
      expect(mockForget).not.toHaveBeenCalled()
    },
  )

  it.each(invalidMutationCases)(
    "checks capability before validating %s input",
    async (_name, action) => {
      mockHasCapabilityAccess.mockResolvedValue(false)

      await expect(action()).resolves.toMatchObject({ isSuccess: false })
      expect(mockHasCapabilityAccess).toHaveBeenCalledWith(
        "nexus-memory",
        "cognito-sub",
      )
      expect(mockExecuteQuery).not.toHaveBeenCalled()
    },
  )

  it("rejects editing another user's memory before the write pipeline", async () => {
    mockExecuteQuery.mockResolvedValue([{ id: FOREIGN_MEMORY_ID, userId: 8 }])

    const result = await updateNexusMemory({
      memoryId: FOREIGN_MEMORY_ID,
      content: "Changed content",
      category: "context",
    })

    expect(result.isSuccess).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("rejects deleting another user's memory", async () => {
    mockExecuteQuery.mockResolvedValue([{ id: FOREIGN_MEMORY_ID, userId: 8 }])

    const result = await deleteNexusMemory(FOREIGN_MEMORY_ID)

    expect(result.isSuccess).toBe(false)
    expect(mockForget).not.toHaveBeenCalled()
  })
})

describe("Nexus memory settings action listing", () => {
  beforeEach(resetMemoryActionMocks)

  it("returns only a bounded page and a stable continuation cursor", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => {
      const sequence = index + 1
      return {
        id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        content: `Memory ${sequence}`,
        category: "context" as const,
        source: "manual" as const,
        createdAt: new Date("2026-07-28T10:00:00.000Z"),
        updatedAt: new Date(
          Date.parse("2026-07-28T12:00:00.000Z") - sequence * 1_000,
        ),
        cursorUpdatedAtMicros: String(1_785_254_400_000_000 - sequence),
      }
    })
    mockExecuteQuery
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ settings: { memoryEnabled: false } }])

    const result = await listNexusMemories()

    expect(result).toMatchObject({
      isSuccess: true,
      data: {
        memories: expect.arrayContaining([
          expect.objectContaining({ content: "Memory 1" }),
        ]),
        memoryEnabled: false,
        globalMemoryEnabled: true,
        nextCursor: {
          updatedAtMicros: rows[49]?.cursorUpdatedAtMicros,
          id: rows[49]?.id,
        },
      },
    })
    expect(result.isSuccess && result.data.memories).toHaveLength(50)
  })
})

describe("Nexus memory settings action mutations", () => {
  beforeEach(resetMemoryActionMocks)

  it("rejects a bulk delete containing another user's memory", async () => {
    const transaction = useBulkTransaction([
      { id: MEMORY_ID, userId: 7 },
      { id: FOREIGN_MEMORY_ID, userId: 8 },
    ])

    const result = await bulkDeleteNexusMemories([MEMORY_ID, FOREIGN_MEMORY_ID])

    expect(result.isSuccess).toBe(false)
    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1)
    expect(transaction.update).not.toHaveBeenCalled()
  })

  it("rolls back a bulk delete when the locked row count changes", async () => {
    useBulkTransaction(
      [
        { id: MEMORY_ID, userId: 7 },
        { id: FOREIGN_MEMORY_ID, userId: 7 },
      ],
      [MEMORY_ID],
    )

    const result = await bulkDeleteNexusMemories([MEMORY_ID, FOREIGN_MEMORY_ID])

    expect(result.isSuccess).toBe(false)
    expect(mockExecuteTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      "bulkSoftDeleteOwnedNexusMemories",
    )
  })

  it("bulk-deletes all selected owned memories atomically", async () => {
    useBulkTransaction([
      { id: MEMORY_ID, userId: 7 },
      { id: FOREIGN_MEMORY_ID, userId: 7 },
    ])

    const result = await bulkDeleteNexusMemories([MEMORY_ID, FOREIGN_MEMORY_ID])

    expect(result).toMatchObject({
      isSuccess: true,
      data: { deletedCount: 2 },
    })
  })

  it("routes an owned edit through the shared re-sanitize and re-embed service", async () => {
    const updated = {
      id: MEMORY_ID,
      userId: 7,
      content: "Prefers short summaries",
      category: "preference",
      source: "manual",
      sourceConversationId: null,
      createdAt: new Date("2026-07-28T10:00:00.000Z"),
      updatedAt: new Date("2026-07-28T11:00:00.000Z"),
    }
    mockExecuteQuery.mockResolvedValue([{ id: MEMORY_ID, userId: 7 }])
    mockUpdate.mockResolvedValue(updated)

    const result = await updateNexusMemory({
      memoryId: MEMORY_ID,
      content: "Prefers short summaries",
      category: "preference",
    })

    expect(result.isSuccess).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith({
      memoryId: MEMORY_ID,
      userId: 7,
      sessionId: "cognito-sub",
      content: "Prefers short summaries",
      category: "preference",
    })
  })

  it("delegates the memory toggle to the atomic settings merge", async () => {
    const result = await setNexusMemoryEnabled(false)

    expect(result).toMatchObject({
      isSuccess: true,
      data: { enabled: false },
    })
    expect(mockMergeNexusUserSettings).toHaveBeenCalledWith(7, {
      memoryEnabled: false,
    })
  })

  it("rejects account toggle changes while memory is globally disabled", async () => {
    mockIsNexusMemoryGloballyEnabled.mockResolvedValue(false)

    const result = await setNexusMemoryEnabled(false)

    expect(result).toMatchObject({ isSuccess: false })
    expect(mockIsNexusMemoryGloballyEnabled).toHaveBeenCalled()
    expect(mockMergeNexusUserSettings).not.toHaveBeenCalled()
  })

  it.each([
    [
      "add",
      () =>
        addNexusMemory({
          content: "Prefers concise answers",
          category: "preference",
        }),
    ],
    [
      "update",
      () =>
        updateNexusMemory({
          memoryId: MEMORY_ID,
          content: "Prefers concise answers",
          category: "preference",
        }),
    ],
  ])(
    "rejects %s when the global memory switch is off",
    async (_name, action) => {
      mockIsNexusMemoryGloballyEnabled.mockResolvedValue(false)

      await expect(action()).resolves.toMatchObject({ isSuccess: false })
      expect(mockSave).not.toHaveBeenCalled()
      expect(mockUpdate).not.toHaveBeenCalled()
      expect(mockExecuteQuery).not.toHaveBeenCalled()
      expect(mockIsNexusMemoryEnabledForUser).not.toHaveBeenCalled()
    },
  )

  it.each([
    [
      "add",
      () =>
        addNexusMemory({
          content: "Prefers concise answers",
          category: "preference",
        }),
    ],
    [
      "update",
      () =>
        updateNexusMemory({
          memoryId: MEMORY_ID,
          content: "Prefers concise answers",
          category: "preference",
        }),
    ],
  ])("rejects %s when memory is off for the account", async (_name, action) => {
    mockIsNexusMemoryEnabledForUser.mockResolvedValue(false)

    await expect(action()).resolves.toMatchObject({ isSuccess: false })
    expect(mockIsNexusMemoryEnabledForUser).toHaveBeenCalledWith(7)
    expect(mockSave).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })
})
