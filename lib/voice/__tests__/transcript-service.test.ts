/**
 * Tests for Voice Transcript Persistence Service
 *
 * Tests transcript preparation (merge, filter), guardrail integration (mocked),
 * title generation, and the full save flow with mocked DB operations.
 *
 * Issue #875
 */

import { saveVoiceTranscript, prepareTranscriptEntries } from "../transcript-service"
import { DEFAULT_CONVERSATION_TITLE } from "@/lib/constants/conversation"
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

// Logger mock — the factory creates a singleton logger object with jest.fn() methods.
// We retrieve it after jest.mock via the mocked module's createLogger().
jest.mock("@/lib/logger", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  return {
    __mockLogger: logger,
    createLogger: () => logger,
    generateRequestId: () => "test-request-id",
    startTimer: () => jest.fn().mockReturnValue(42),
  }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { __mockLogger: mockLogger } = require("@/lib/logger") as { __mockLogger: {
  info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock
}}

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

  it("should cap at 500 entries, keeping the most recent (tail)", () => {
    const entries: TranscriptEntry[] = []
    for (let i = 0; i < 600; i++) {
      entries.push(
        makeEntry(i % 2 === 0 ? "user" : "assistant", `message ${i}`),
      )
    }

    const result = prepareTranscriptEntries(entries)
    expect(result.length).toBeLessThanOrEqual(500)
    // Verify tail entries are kept (most recent), not head entries
    const lastEntry = result[result.length - 1]
    expect(lastEntry.text).toBe("message 599")
  })

  it("should warn when transcript is truncated beyond MAX_TRANSCRIPT_ENTRIES", () => {
    mockLogger.warn.mockClear()
    const entries: TranscriptEntry[] = []
    for (let i = 0; i < 600; i++) {
      entries.push(
        makeEntry(i % 2 === 0 ? "user" : "assistant", `message ${i}`),
      )
    }

    prepareTranscriptEntries(entries)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Transcript truncated to maximum entry limit",
      expect.objectContaining({
        maxEntries: 500,
        droppedCount: expect.any(Number),
      }),
    )
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
    ).rejects.toThrow("Conversation not found or access denied")
  })

  it("should return early with zero counts for empty transcript", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Test" })

    const result = await saveVoiceTranscript("conv-123", 1, [])
    expect(result.messageCount).toBe(0)
    expect(result.filteredCount).toBe(0)
    expect(result.titleGenerated).toBe(false)
    expect(result.guardrailsBypassed).toBe(false)
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
    expect(result.guardrailsBypassed).toBe(true)
    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1)
    // Guardrail checks should not have been called
    expect(mockCheckInputSafety).not.toHaveBeenCalled()
    expect(mockCheckOutputSafety).not.toHaveBeenCalled()
  })

  it("should generate title for new conversations", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: DEFAULT_CONVERSATION_TITLE })
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
    expect(result.guardrailsBypassed).toBe(false)
    expect(mockCheckInputSafety).toHaveBeenCalledTimes(2)
    expect(mockCheckOutputSafety).toHaveBeenCalledTimes(1)
  })

  it("should pass voiceModel and voiceProvider to checkOutputSafety", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Test" })
    mockIsGuardrailsEnabled.mockReturnValue(true)
    mockCheckInputSafety.mockResolvedValue({ allowed: true, processedContent: "hello" })
    mockCheckOutputSafety.mockResolvedValue({ allowed: true, processedContent: "hi" })

    mockExecuteTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        insert: jest.fn().mockReturnValue({ values: jest.fn() }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) }),
      })
    })

    const entries = [
      makeEntry("user", "hello"),
      makeEntry("assistant", "hi there"),
    ]

    await saveVoiceTranscript("conv-123", 1, entries, "gemini-2.0-flash-live-001", "gemini-live")

    // Verify checkOutputSafety received the actual model and provider, not hardcoded values
    expect(mockCheckOutputSafety).toHaveBeenCalledWith(
      "hi there",
      "gemini-2.0-flash-live-001",
      "gemini-live",
      "voice-conv-123",
    )
  })

  it("should use fallback strings when voiceModel/voiceProvider are undefined", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Test" })
    mockIsGuardrailsEnabled.mockReturnValue(true)
    mockCheckInputSafety.mockResolvedValue({ allowed: true, processedContent: "hello" })
    mockCheckOutputSafety.mockResolvedValue({ allowed: true, processedContent: "hi" })

    mockExecuteTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        insert: jest.fn().mockReturnValue({ values: jest.fn() }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) }),
      })
    })

    const entries = [
      makeEntry("user", "hello"),
      makeEntry("assistant", "hi there"),
    ]

    // Call without voiceModel and voiceProvider
    await saveVoiceTranscript("conv-123", 1, entries)

    expect(mockCheckOutputSafety).toHaveBeenCalledWith(
      "hi there",
      "unknown-voice-model",
      "unknown-voice-provider",
      "voice-conv-123",
    )
  })

  it("should use processedContent from guardrails when content is transformed", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Test" })
    mockIsGuardrailsEnabled.mockReturnValue(true)
    // Simulate safety service returning transformed content (e.g., PII redaction)
    mockCheckInputSafety.mockResolvedValue({ allowed: true, processedContent: "hello [REDACTED]" })
    mockCheckOutputSafety.mockResolvedValue({ allowed: true, processedContent: "transformed response" })

    let capturedValues: unknown[] = []
    mockExecuteTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        insert: jest.fn().mockImplementation((_table: unknown) => ({
          values: jest.fn().mockImplementation((vals: unknown[]) => {
            capturedValues = vals
          }),
        })),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) }),
      })
    })

    const entries = [
      makeEntry("user", "hello original"),
      makeEntry("assistant", "original response"),
    ]

    await saveVoiceTranscript("conv-123", 1, entries)

    // Verify the persisted content uses processedContent, not original text
    expect(capturedValues).toHaveLength(2)
    expect((capturedValues[0] as { content: string }).content).toBe("hello [REDACTED]")
    expect((capturedValues[1] as { content: string }).content).toBe("transformed response")
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
    // Individual entry errors are handled gracefully within the batch — the guardrail
    // pipeline itself completed, so bypassed is false. bypassed=true only when the
    // entire pipeline was skipped (disabled or timed out).
    expect(result.guardrailsBypassed).toBe(false)
  })

  it("should write modelUsed to conversation metadata when voiceModel is provided", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Existing" })
    mockIsGuardrailsEnabled.mockReturnValue(false)

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

    const entries = [makeEntry("user", "hello")]
    await saveVoiceTranscript("conv-123", 1, entries, "gemini-2.0-flash-live-001")

    // Verify modelUsed is passed in the .set() call — confirms the column name
    // matches the schema (nexusConversations.modelUsed → model_used varchar(100))
    expect(updateArgs.modelUsed).toBe("gemini-2.0-flash-live-001")
  })

  it("should not write modelUsed when voiceModel is not provided", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Existing" })
    mockIsGuardrailsEnabled.mockReturnValue(false)

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

    const entries = [makeEntry("user", "hello")]
    await saveVoiceTranscript("conv-123", 1, entries)

    // When voiceModel is undefined, modelUsed should NOT be in the update
    expect(updateArgs.modelUsed).toBeUndefined()
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

  it("should propagate getConversationById errors (DB failure vs returning null)", async () => {
    mockGetConversationById.mockRejectedValue(new Error("Connection refused"))

    const entries = [makeEntry("user", "hello")]
    await expect(
      saveVoiceTranscript("conv-123", 1, entries),
    ).rejects.toThrow("Connection refused")
  })

  it("should fall back to original text when processedContent is null or undefined", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Test" })
    mockIsGuardrailsEnabled.mockReturnValue(true)
    // Return null/undefined processedContent — should fall back to original entry text
    mockCheckInputSafety.mockResolvedValue({ allowed: true, processedContent: null })
    mockCheckOutputSafety.mockResolvedValue({ allowed: true, processedContent: undefined })

    let capturedValues: unknown[] = []
    mockExecuteTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        insert: jest.fn().mockImplementation((_table: unknown) => ({
          values: jest.fn().mockImplementation((vals: unknown[]) => {
            capturedValues = vals
          }),
        })),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) }),
      })
    })

    const entries = [
      makeEntry("user", "original user text"),
      makeEntry("assistant", "original assistant text"),
    ]

    await saveVoiceTranscript("conv-123", 1, entries)

    // With null/undefined processedContent, the original text should be used
    expect(capturedValues).toHaveLength(2)
    expect((capturedValues[0] as { content: string }).content).toBe("original user text")
    expect((capturedValues[1] as { content: string }).content).toBe("original assistant text")
  })

  it("should process entries correctly across guardrail batch boundaries", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: "Existing" })
    mockIsGuardrailsEnabled.mockReturnValue(true)
    mockCheckInputSafety.mockResolvedValue({ allowed: true, processedContent: "user msg" })
    mockCheckOutputSafety.mockResolvedValue({ allowed: true, processedContent: "assistant msg" })

    let capturedValues: unknown[] = []
    mockExecuteTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        insert: jest.fn().mockImplementation((_table: unknown) => ({
          values: jest.fn().mockImplementation((vals: unknown[]) => {
            capturedValues = vals
          }),
        })),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) }),
      })
    })

    // 25 entries — crosses the GUARDRAIL_CONCURRENCY_LIMIT (20) boundary
    const entries: TranscriptEntry[] = []
    for (let i = 0; i < 25; i++) {
      entries.push(makeEntry(i % 2 === 0 ? "user" : "assistant", `message ${i}`))
    }

    const result = await saveVoiceTranscript("conv-123", 1, entries)

    // All 25 entries should be saved — no entries dropped at batch boundary
    expect(result.messageCount).toBe(25)
    expect(capturedValues).toHaveLength(25)
    // Verify guardrail checks were called for all entries
    expect(mockCheckInputSafety.mock.calls.length + mockCheckOutputSafety.mock.calls.length).toBe(25)
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
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: DEFAULT_CONVERSATION_TITLE })

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
    // Title is at most 40 chars + "..." (43 total); trim() may make it shorter
    expect(updateArgs.title).toBeDefined()
    const title = updateArgs.title as string
    expect(title.length).toBeLessThanOrEqual(43)
    expect(title.endsWith("...")).toBe(true)
  })

  it("should skip title generation if first user message was filtered", async () => {
    mockGetConversationById.mockResolvedValue({ id: "conv-123", title: DEFAULT_CONVERSATION_TITLE })
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
