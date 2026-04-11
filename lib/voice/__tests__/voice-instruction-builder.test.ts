/**
 * Tests for server-side voice instruction builder.
 * Validates conversation ownership, message extraction, and instruction formatting.
 *
 * Issue #874, #895
 */

// Mock logger
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}))

// Mock DB functions
const mockGetUserIdByCognitoSub = jest.fn()
const mockGetConversationById = jest.fn()
const mockExecuteQuery = jest.fn()

jest.mock("@/lib/db/drizzle/users", () => ({
  getUserIdByCognitoSub: (...args: unknown[]) => mockGetUserIdByCognitoSub(...args),
}))

jest.mock("@/lib/db/drizzle/nexus-conversations", () => ({
  getConversationById: (...args: unknown[]) => mockGetConversationById(...args),
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}))

jest.mock("@/lib/db/schema", () => ({
  nexusMessages: {
    conversationId: "conversation_id",
    role: "role",
    content: "content",
    parts: "parts",
    createdAt: "created_at",
  },
}))

import { buildInstructionFromConversation } from "../voice-instruction-builder"

describe("buildInstructionFromConversation", () => {
  const testConversationId = "550e8400-e29b-41d4-a716-446655440000"
  const testCognitoSub = "cognito-sub-123"

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should return undefined when user ID cannot be resolved", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue(null)

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).toBeUndefined()
    expect(mockGetConversationById).not.toHaveBeenCalled()
  })

  it("should return undefined when conversation not found or not owned", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue(null)

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).toBeUndefined()
    expect(mockGetConversationById).toHaveBeenCalledWith(testConversationId, 42)
  })

  it("should return undefined when conversation has no messages", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue({ id: testConversationId })
    mockExecuteQuery.mockResolvedValue([])

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).toBeUndefined()
  })

  it("should build instruction from conversation messages", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue({ id: testConversationId })
    // executeQuery returns messages in DESC order (newest first), builder reverses
    mockExecuteQuery.mockResolvedValue([
      {
        role: "assistant",
        parts: [{ type: "text", text: "Photosynthesis is how plants convert sunlight into energy." }],
        content: null,
      },
      {
        role: "user",
        parts: [{ type: "text", text: "What is photosynthesis?" }],
        content: null,
      },
    ])

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).toBeDefined()
    // After reverse, user message comes first
    expect(result).toContain("User: What is photosynthesis?")
    expect(result).toContain("Assistant: Photosynthesis is how plants convert sunlight")
    expect(result).toContain("Prior conversation")
    expect(result).toContain("Continue the conversation naturally in voice")
    // Verify chronological order (user before assistant)
    const userIdx = result!.indexOf("User: What")
    const assistantIdx = result!.indexOf("Assistant: Photosynthesis")
    expect(userIdx).toBeLessThan(assistantIdx)
  })

  it("should skip non-text message parts", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue({ id: testConversationId })
    mockExecuteQuery.mockResolvedValue([
      {
        role: "assistant",
        parts: [
          { type: "tool-call", toolName: "analyze_image", toolCallId: "1" },
          { type: "text", text: "This appears to be a plant." },
        ],
        content: null,
      },
      {
        role: "user",
        parts: [
          { type: "image", imageUrl: "https://example.com/img.png" },
          { type: "text", text: "What is this?" },
        ],
        content: null,
      },
    ])

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).toContain("User: What is this?")
    expect(result).toContain("Assistant: This appears to be a plant.")
    expect(result).not.toContain("image")
    expect(result).not.toContain("tool")
  })

  it("should fall back to content field when parts is null", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue({ id: testConversationId })
    mockExecuteQuery.mockResolvedValue([
      { role: "user", parts: null, content: "Plain text message" },
    ])

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).toContain("User: Plain text message")
  })

  it("should skip system messages", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue({ id: testConversationId })
    mockExecuteQuery.mockResolvedValue([
      { role: "user", parts: [{ type: "text", text: "Hello" }], content: null },
      { role: "system", parts: [{ type: "text", text: "System prompt" }], content: null },
    ])

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).not.toContain("System prompt")
    expect(result).toContain("User: Hello")
  })

  it("should truncate instruction to 10K characters", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue({ id: testConversationId })

    // Create messages that would exceed 10K
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text" as const, text: `Message ${i}: ${"X".repeat(1000)}` }],
      content: null,
    }))
    mockExecuteQuery.mockResolvedValue(messages)

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).toBeDefined()
    expect(result!.length).toBeLessThanOrEqual(10_000)
  })

  it("should use single DESC query instead of count+fetch", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue({ id: testConversationId })
    mockExecuteQuery.mockResolvedValue([
      { role: "user", parts: [{ type: "text", text: "Hello" }], content: null },
    ])

    await buildInstructionFromConversation(testConversationId, testCognitoSub)

    // Should make exactly 1 executeQuery call (not 2 for count+fetch)
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.any(Function),
      "getRecentMessagesForVoice",
    )
  })
})
