/**
 * Tests for Voice Transcript Persistence Service
 *
 * Tests transcript preparation (merge, filter), guardrail integration (mocked),
 * title generation, and the full save flow with mocked DB operations.
 *
 * Issue #875
 */

import { saveVoiceTranscript, prepareTranscriptEntries } from "../transcript-service"
import type { TranscriptEntry } from "../types"

// ============================================
// Mocks
// ============================================

const mockExecuteTransaction = jest.fn()
const mockGetConversationById = jest.fn()

jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: (...args: unknown[]) => mockExecuteTransaction(...args),
}))

jest.mock("@/lib/db/drizzle/nexus-conversations", () => ({
  getConversationById: (...args: unknown[]) => mockGetConversationById(...args),
}))

jest.mock("@/lib/db/schema", () => ({
  nexusMessages: { id: "id", conversationId: "conversation_id", role: "role" },
  nexusConversations: { id: "id", messageCount: "message_count" },
}))

jest.mock("@/lib/db/json-utils", () => ({
  safeJsonbStringify: (val: unknown) => JSON.stringify(val),
}))

// Mock drizzle-orm's sql template tag and eq function
jest.mock("drizzle-orm", () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values, _tag: "sql" }),
    { raw: (s: string) => ({ raw: s, _tag: "sql" }) },
  ),
  eq: (a: unknown, b: unknown) => ({ a, b, _tag: "eq" }),
}))

const mockCheckInputSafety = jest.fn()
const mockCheckOutputSafety = jest.fn()
const mockIsGuardrailsEnabled = jest.fn()

jest.mock("@/lib/safety", () => ({
  getContentSafetyService: () => ({
    isGuardrailsEnabled: mockIsGuardrailsEnabled,
    checkInputSafety: mockCheckInputSafety,
    checkOutputSafety: mockCheckOutputSafety,
  }),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: () => "test-request-id",
  startTimer: () => jest.fn().mockReturnValue(42),
}))

// ============================================
// Test Helpers
// ============================================

function makeEntry(
  role: "user" | "assistant",
  text: string,
  opts?: { isFinal?: boolean; timestamp?: Date },
): TranscriptEntry {
  return {
    role,
    text,
    isFinal: opts?.isFinal ?? true,
    timestamp: opts?.timestamp ?? new Date("2026-04-11T10:00:00Z"),
  }
}

// ============================================
// Tests: prepareTranscriptEntries
// ============================================

describe("prepareTranscriptEntries", () => {
  it("should filter out non-final entries", () => {
    const entries = [
      makeEntry("user", "hello", { isFinal: false }),
      makeEntry("user", "hello world", { isFinal: true }),
      makeEntry("assistant", "partial", { isFinal: false }),
      makeEntry("assistant", "hi there", { isFinal: true }),
    ]

    const result = prepareTranscriptEntries(entries)
    expect(result).toHaveLength(2)
    expect(result[0].text).toBe("hello world")
    expect(result[1].text).toBe("hi there")
  })

  it("should filter out empty text entries", () => {
    const entries = [
      makeEntry("user", "", { isFinal: true }),
      makeEntry("user", "  ", { isFinal: true }),
      makeEntry("user", "actual content", { isFinal: true }),
    ]

    const result = prepareTranscriptEntries(entries)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe("actual content")
  })

  it("should merge consecutive same-role entries", () => {
    const t1 = new Date("2026-04-11T10:00:00Z")
    const t2 = new Date("2026-04-11T10:00:01Z")
    const t3 = new Date("2026-04-11T10:00:02Z")

    const entries = [
      makeEntry("user", "hello", { timestamp: t1 }),
      makeEntry("user", "how are you?", { timestamp: t2 }),
      makeEntry("assistant", "I'm good", { timestamp: t3 }),
    ]

    const result = prepareTranscriptEntries(entries)
    expect(result).toHaveLength(2)
    expect(result[0].role).toBe("user")
    expect(result[0].text).toBe("hello how are you?")
    // Keeps the earlier timestamp
    expect(result[0].timestamp).toBe(t1)
    expect(result[1].role).toBe("assistant")
    expect(result[1].text).toBe("I'm good")
  })

  it("should not merge entries with different roles", () => {
    const entries = [
      makeEntry("user", "hello"),
      makeEntry("assistant", "hi"),
      makeEntry("user", "another question"),
    ]

    const result = prepareTranscriptEntries(entries)
    expect(result).toHaveLength(3)
  })

  it("should return empty array for empty input", () => {
    expect(prepareTranscriptEntries([])).toHaveLength(0)
  })

  it("should return empty array when all entries are non-final", () => {
    const entries = [
      makeEntry("user", "partial", { isFinal: false }),
      makeEntry("assistant", "also partial", { isFinal: false }),
    ]
    expect(prepareTranscriptEntries(entries)).toHaveLength(0)
  })

  it("should cap at 500 entries", () => {
    const entries: TranscriptEntry[] = []
    for (let i = 0; i < 600; i++) {
      entries.push(
        makeEntry(i % 2 === 0 ? "user" : "assistant", `message ${i}`),
      )
    }

    const result = prepareTranscriptEntries(entries)
    expect(result.length).toBeLessThanOrEqual(500)
  })

  it("should trim whitespace from entry text", () => {
    const entries = [
      makeEntry("user", "  hello world  "),
    ]

    const result = prepareTranscriptEntries(entries)
    expect(result[0].text).toBe("hello world")
  })
})

// ============================================
// Tests: saveVoiceTranscript
// ============================================

describe("saveVoiceTranscript", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsGuardrailsEnabled.mockReturnValue(false)
    mockCheckInputSafety.mockResolvedValue({ allowed: true, processedContent: "test" })
    mockCheckOutputSafety.mockResolvedValue({ allowed: true, processedContent: "test" })
  })

  it("should throw if conversation not found", async () => {
    mockGetConversationById.mockResolvedValue(null)

    const entries = [makeEntry("user", "hello")]
    await expect(
      saveVoiceTranscript("conv-123", 1, entries),
    ).rejects.toThrow("Conversation conv-123 not found")
  })

  it("should return early with zero counts for empty transcript", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Test" })

    const result = await saveVoiceTranscript("conv-123", 1, [])
    expect(result.messageCount).toBe(0)
    expect(result.filteredCount).toBe(0)
    expect(result.titleGenerated).toBe(false)
    expect(mockExecuteTransaction).not.toHaveBeenCalled()
  })

  it("should return early for transcript with only non-final entries", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Test" })

    const entries = [
      makeEntry("user", "partial", { isFinal: false }),
    ]
    const result = await saveVoiceTranscript("conv-123", 1, entries)
    expect(result.messageCount).toBe(0)
    expect(mockExecuteTransaction).not.toHaveBeenCalled()
  })

  it("should save transcript without guardrails when disabled", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Existing Title" })
    mockIsGuardrailsEnabled.mockReturnValue(false)
    mockExecuteTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const mockTx = {
        insert: jest.fn().mockReturnValue({ values: jest.fn() }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) }),
      }
      await fn(mockTx)
    })

    const entries = [
      makeEntry("user", "hello"),
      makeEntry("assistant", "hi there"),
    ]

    const result = await saveVoiceTranscript("conv-123", 1, entries, "gemini-2.0-flash-live-001")
    expect(result.messageCount).toBe(2)
    expect(result.filteredCount).toBe(0)
    expect(result.titleGenerated).toBe(false)
    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1)
    // Guardrail checks should not have been called
    expect(mockCheckInputSafety).not.toHaveBeenCalled()
    expect(mockCheckOutputSafety).not.toHaveBeenCalled()
  })

  it("should generate title for new conversations", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "New Conversation" })
    mockIsGuardrailsEnabled.mockReturnValue(false)

    let capturedTx: Record<string, jest.Mock> | null = null
    mockExecuteTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      capturedTx = {
        insert: jest.fn().mockReturnValue({ values: jest.fn() }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({ where: jest.fn() }),
        }),
      }
      await fn(capturedTx)
    })

    const entries = [
      makeEntry("user", "Tell me about the solar system"),
      makeEntry("assistant", "The solar system consists of..."),
    ]

    const result = await saveVoiceTranscript("conv-123", 1, entries)
    expect(result.titleGenerated).toBe(true)

    // Verify the update was called with a title
    expect(capturedTx).not.toBeNull()
    const setCall = capturedTx!.update.mock.results[0]?.value?.set
    expect(setCall).toBeDefined()
  })

  it("should not generate title when conversation already has one", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "My Existing Chat" })
    mockIsGuardrailsEnabled.mockReturnValue(false)
    mockExecuteTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        insert: jest.fn().mockReturnValue({ values: jest.fn() }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) }),
      })
    })

    const entries = [makeEntry("user", "hello")]
    const result = await saveVoiceTranscript("conv-123", 1, entries)
    expect(result.titleGenerated).toBe(false)
  })

  it("should apply guardrails and filter blocked content", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Test" })
    mockIsGuardrailsEnabled.mockReturnValue(true)

    // First user message is blocked, second passes
    mockCheckInputSafety
      .mockResolvedValueOnce({
        allowed: false,
        processedContent: "blocked",
        blockedReason: "Violence",
        blockedCategories: ["Violence"],
      })
      .mockResolvedValueOnce({ allowed: true, processedContent: "good content" })

    mockCheckOutputSafety.mockResolvedValue({ allowed: true, processedContent: "response" })

    mockExecuteTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        insert: jest.fn().mockReturnValue({ values: jest.fn() }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) }),
      })
    })

    const entries = [
      makeEntry("user", "blocked content"),
      makeEntry("assistant", "response"),
      makeEntry("user", "good content"),
    ]

    const result = await saveVoiceTranscript("conv-123", 1, entries)
    expect(result.messageCount).toBe(3)
    expect(result.filteredCount).toBe(1)
    expect(mockCheckInputSafety).toHaveBeenCalledTimes(2)
    expect(mockCheckOutputSafety).toHaveBeenCalledTimes(1)
  })

  it("should gracefully handle guardrail API errors", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Test" })
    mockIsGuardrailsEnabled.mockReturnValue(true)
    mockCheckInputSafety.mockRejectedValue(new Error("Bedrock unavailable"))
    mockCheckOutputSafety.mockResolvedValue({ allowed: true, processedContent: "ok" })

    mockExecuteTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        insert: jest.fn().mockReturnValue({ values: jest.fn() }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) }),
      })
    })

    const entries = [
      makeEntry("user", "hello"),
      makeEntry("assistant", "hi"),
    ]

    // Should not throw — graceful degradation
    const result = await saveVoiceTranscript("conv-123", 1, entries)
    expect(result.messageCount).toBe(2)
    expect(result.filteredCount).toBe(0)
  })

  it("should propagate transaction errors", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Test" })
    mockIsGuardrailsEnabled.mockReturnValue(false)
    mockExecuteTransaction.mockRejectedValue(new Error("DB connection lost"))

    const entries = [makeEntry("user", "hello")]
    await expect(
      saveVoiceTranscript("conv-123", 1, entries),
    ).rejects.toThrow("DB connection lost")
  })
})

// ============================================
// Tests: Title Generation (via saveVoiceTranscript)
// ============================================

describe("voice title generation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsGuardrailsEnabled.mockReturnValue(false)
  })

  it("should truncate long titles with ellipsis", async () => {
    const longMessage = "This is a very long message that should be truncated because it exceeds the maximum title length"
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "New Conversation" })

    let updateArgs: Record<string, unknown> = {}
    mockExecuteTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        insert: jest.fn().mockReturnValue({ values: jest.fn() }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockImplementation((args: Record<string, unknown>) => {
            updateArgs = args
            return { where: jest.fn() }
          }),
        }),
      })
    })

    const entries = [makeEntry("user", longMessage)]
    const result = await saveVoiceTranscript("conv-123", 1, entries)
    expect(result.titleGenerated).toBe(true)
    // Title should be 40 chars + "..."
    expect(updateArgs.title).toBeDefined()
    const title = updateArgs.title as string
    expect(title.length).toBeLessThanOrEqual(43)
    expect(title.endsWith("...")).toBe(true)
  })

  it("should skip title generation if first user message was filtered", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "New Conversation" })
    mockIsGuardrailsEnabled.mockReturnValue(true)
    // Block the only user message
    mockCheckInputSafety.mockResolvedValue({
      allowed: false,
      processedContent: "blocked",
      blockedReason: "Violence",
    })
    mockCheckOutputSafety.mockResolvedValue({ allowed: true, processedContent: "ok" })

    let updateArgs: Record<string, unknown> = {}
    mockExecuteTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        insert: jest.fn().mockReturnValue({ values: jest.fn() }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockImplementation((args: Record<string, unknown>) => {
            updateArgs = args
            return { where: jest.fn() }
          }),
        }),
      })
    })

    const entries = [
      makeEntry("user", "violent content"),
      makeEntry("assistant", "ok"),
    ]
    const result = await saveVoiceTranscript("conv-123", 1, entries)
    // Title should NOT be generated because the user entry was filtered
    expect(result.titleGenerated).toBe(false)
    expect(updateArgs.title).toBeUndefined()
  })
})
