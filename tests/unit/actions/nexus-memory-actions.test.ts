/* eslint-disable no-var */
var mockGetServerSession = jest.fn()
var mockHasCapabilityAccess = jest.fn()
var mockGetUserId = jest.fn()
var mockExecuteQuery = jest.fn()
var mockSave = jest.fn()
var mockUpdate = jest.fn()
var mockForget = jest.fn()
var mockSafeJsonbStringify = jest.fn()
var mockRevalidatePath = jest.fn()
/* eslint-enable no-var */

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))

jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...args: unknown[]) =>
    mockHasCapabilityAccess(...args),
}))

jest.mock("@/lib/db/drizzle", () => ({
  getUserIdByCognitoSubAsNumber: (...args: unknown[]) =>
    mockGetUserId(...args),
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}))

jest.mock("@/lib/nexus/memory/memory-service", () => ({
  memoryService: {
    save: (...args: unknown[]) => mockSave(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    forget: (...args: unknown[]) => mockForget(...args),
  },
}))

jest.mock("@/lib/db/json-utils", () => ({
  safeJsonbStringify: (...args: unknown[]) =>
    mockSafeJsonbStringify(...args),
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

describe("Nexus memory settings actions", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: "cognito-sub" })
    mockHasCapabilityAccess.mockResolvedValue(true)
    mockGetUserId.mockResolvedValue(7)
    mockSafeJsonbStringify.mockReturnValue("serialized-settings")
  })

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
  ])("rejects the %s action without nexus-memory capability", async (
    _name,
    action,
  ) => {
    mockHasCapabilityAccess.mockResolvedValue(false)

    await expect(action()).resolves.toMatchObject({ isSuccess: false })
    expect(mockExecuteQuery).not.toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockForget).not.toHaveBeenCalled()
  })

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
    mockExecuteQuery.mockResolvedValue([
      { id: FOREIGN_MEMORY_ID, userId: 8 },
    ])

    const result = await updateNexusMemory({
      memoryId: FOREIGN_MEMORY_ID,
      content: "Changed content",
      category: "context",
    })

    expect(result.isSuccess).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("rejects deleting another user's memory", async () => {
    mockExecuteQuery.mockResolvedValue([
      { id: FOREIGN_MEMORY_ID, userId: 8 },
    ])

    const result = await deleteNexusMemory(FOREIGN_MEMORY_ID)

    expect(result.isSuccess).toBe(false)
    expect(mockForget).not.toHaveBeenCalled()
  })

  it("rejects a bulk delete containing another user's memory", async () => {
    mockExecuteQuery.mockResolvedValue([
      { id: MEMORY_ID, userId: 7 },
      { id: FOREIGN_MEMORY_ID, userId: 8 },
    ])

    const result = await bulkDeleteNexusMemories([
      MEMORY_ID,
      FOREIGN_MEMORY_ID,
    ])

    expect(result.isSuccess).toBe(false)
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
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

  it("merges memoryEnabled in TypeScript without discarding other settings", async () => {
    mockExecuteQuery
      .mockResolvedValueOnce([
        {
          settings: {
            nexusMode: "advanced",
            preferredModelFamily: "google",
          },
        },
      ])
      .mockResolvedValueOnce([])

    const result = await setNexusMemoryEnabled(false)

    expect(result).toMatchObject({
      isSuccess: true,
      data: { enabled: false },
    })
    expect(mockSafeJsonbStringify).toHaveBeenCalledWith({
      nexusMode: "advanced",
      preferredModelFamily: "google",
      memoryEnabled: false,
    })
  })
})
