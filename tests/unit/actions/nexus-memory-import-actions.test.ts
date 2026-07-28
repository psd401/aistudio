/* eslint-disable no-var */
var mockGetServerSession = jest.fn()
var mockHasCapabilityAccess = jest.fn()
var mockGetUserId = jest.fn()
var mockGloballyEnabled = jest.fn()
var mockEnabledForUser = jest.fn()
var mockExtractCandidates = jest.fn()
var mockSave = jest.fn()
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

jest.mock("@/lib/nexus/memory/memory-availability", () => ({
  isNexusMemoryGloballyEnabled: (...args: unknown[]) =>
    mockGloballyEnabled(...args),
  isNexusMemoryEnabledForUser: (...args: unknown[]) =>
    mockEnabledForUser(...args),
}))

jest.mock("@/lib/nexus/memory/memory-import", () => ({
  extractMemoryImportCandidates: (...args: unknown[]) =>
    mockExtractCandidates(...args),
}))

jest.mock("@/lib/nexus/memory/memory-service", () => ({
  memoryService: {
    save: (...args: unknown[]) => mockSave(...args),
  },
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
  extractImportCandidates,
  saveImportedMemories,
} from "@/actions/nexus/memory-import.actions"
import { MAX_MEMORY_IMPORT_CHARS } from "@/lib/nexus/memory/memory-constants"

function resetMocks() {
  jest.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ sub: "cognito-sub" })
  mockHasCapabilityAccess.mockResolvedValue(true)
  mockGetUserId.mockResolvedValue(7)
  mockGloballyEnabled.mockResolvedValue(true)
  mockEnabledForUser.mockResolvedValue(true)
}

describe("Nexus memory import extraction actions", () => {
  beforeEach(resetMocks)

  it("extracts a review list without writing any memories", async () => {
    mockExtractCandidates.mockResolvedValue([
      { content: "Prefers concise answers", category: "preference" },
    ])

    const result = await extractImportCandidates({
      vendor: "chatgpt",
      pastedText: "- Prefers concise answers",
    })

    expect(result).toMatchObject({
      isSuccess: true,
      data: {
        candidates: [
          {
            content: "Prefers concise answers",
            category: "preference",
          },
        ],
      },
    })
    expect(mockExtractCandidates).toHaveBeenCalledWith({
      vendor: "chatgpt",
      pastedText: "- Prefers concise answers",
    })
    expect(mockSave).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it("persists nothing when extraction fails", async () => {
    mockExtractCandidates.mockRejectedValue(
      new Error("Injected extraction failure"),
    )

    const result = await extractImportCandidates({
      vendor: "claude",
      pastedText: "- Prefers concise answers",
    })

    expect(result).toMatchObject({
      isSuccess: false,
      message:
        "Failed to extract memories. Your pasted text was not changed.",
    })
    expect(mockSave).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it("rejects an oversized paste before calling the model", async () => {
    const result = await extractImportCandidates({
      vendor: "gemini",
      pastedText: "x".repeat(MAX_MEMORY_IMPORT_CHARS + 1),
    })

    expect(result).toMatchObject({
      isSuccess: false,
      message: `Pasted text cannot exceed ${MAX_MEMORY_IMPORT_CHARS.toLocaleString()} characters`,
    })
    expect(mockExtractCandidates).not.toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it.each([
    [
      "extract",
      () =>
        extractImportCandidates({
          vendor: "chatgpt",
          pastedText: "- Prefers concise answers",
        }),
    ],
    [
      "save",
      () =>
        saveImportedMemories({
          vendor: "chatgpt",
          candidates: [
            {
              content: "Prefers concise answers",
              category: "preference",
            },
          ],
        }),
    ],
  ])(
    "checks nexus-memory capability before the %s action",
    async (_name, action) => {
      mockHasCapabilityAccess.mockResolvedValue(false)

      await expect(action()).resolves.toMatchObject({ isSuccess: false })
      expect(mockExtractCandidates).not.toHaveBeenCalled()
      expect(mockSave).not.toHaveBeenCalled()
    },
  )
})

describe("Nexus memory import save actions", () => {
  beforeEach(resetMocks)

  it("routes only reviewed candidates through the shared write pipeline", async () => {
    mockSave.mockResolvedValue({
      memory: { id: "11111111-1111-4111-8111-111111111111" },
      action: "inserted",
    })

    const result = await saveImportedMemories({
      vendor: "claude",
      candidates: [
        {
          content: "Edited preference from the review step",
          category: "preference",
        },
      ],
    })

    expect(result).toMatchObject({
      isSuccess: true,
      data: { total: 1, successful: 1, failed: 0 },
    })
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave).toHaveBeenCalledWith({
      userId: 7,
      sessionId: "cognito-sub",
      content: "Edited preference from the review step",
      category: "preference",
      source: "import:claude",
    })
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings")
  })

  it("reports partial success without bypassing later candidates", async () => {
    mockSave
      .mockResolvedValueOnce({
        memory: { id: "11111111-1111-4111-8111-111111111111" },
        action: "inserted",
      })
      .mockRejectedValueOnce(new Error("Injected safety rejection"))
      .mockResolvedValueOnce({
        memory: { id: "33333333-3333-4333-8333-333333333333" },
        action: "updated",
      })

    const result = await saveImportedMemories({
      vendor: "gemini",
      candidates: [
        { content: "First fact", category: "profile" },
        { content: "Rejected fact", category: "context" },
        { content: "Third fact", category: "preference" },
      ],
    })

    expect(result).toMatchObject({
      isSuccess: true,
      data: {
        total: 3,
        successful: 2,
        failed: 1,
        results: [
          { index: 0, status: "saved", action: "inserted" },
          { index: 1, status: "failed" },
          { index: 2, status: "saved", action: "updated" },
        ],
      },
    })
    expect(mockSave).toHaveBeenCalledTimes(3)
  })

  it("blocks extraction and writes while account memory is disabled", async () => {
    mockEnabledForUser.mockResolvedValue(false)

    const extractResult = await extractImportCandidates({
      vendor: "chatgpt",
      pastedText: "- Prefers concise answers",
    })
    const saveResult = await saveImportedMemories({
      vendor: "chatgpt",
      candidates: [
        {
          content: "Prefers concise answers",
          category: "preference",
        },
      ],
    })

    expect(extractResult).toMatchObject({ isSuccess: false })
    expect(saveResult).toMatchObject({ isSuccess: false })
    expect(mockExtractCandidates).not.toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
  })
})
