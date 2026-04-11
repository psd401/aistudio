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
const mockGetMessagesByConversation = jest.fn()
const mockGetMessageCount = jest.fn()

jest.mock("@/lib/db/drizzle/users", () => ({
  getUserIdByCognitoSub: (...args: unknown[]) => mockGetUserIdByCognitoSub(...args),
}))

jest.mock("@/lib/db/drizzle/nexus-conversations", () => ({
  getConversationById: (...args: unknown[]) => mockGetConversationById(...args),
}))

jest.mock("@/lib/db/drizzle/nexus-messages", () => ({
  getMessagesByConversation: (...args: unknown[]) => mockGetMessagesByConversation(...args),
  getMessageCount: (...args: unknown[]) => mockGetMessageCount(...args),
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
    mockGetMessageCount.mockResolvedValue(0)

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).toBeUndefined()
  })

  it("should build instruction from conversation messages", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue({ id: testConversationId })
    mockGetMessageCount.mockResolvedValue(2)
    mockGetMessagesByConversation.mockResolvedValue([
      {
        role: "user",
        parts: [{ type: "text", text: "What is photosynthesis?" }],
        content: null,
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "Photosynthesis is how plants convert sunlight into energy." }],
        content: null,
      },
    ])

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).toBeDefined()
    expect(result).toContain("User: What is photosynthesis?")
    expect(result).toContain("Assistant: Photosynthesis is how plants convert sunlight")
    expect(result).toContain("Prior conversation")
    expect(result).toContain("Continue the conversation naturally in voice")
  })

  it("should fetch the most recent messages using offset", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue({ id: testConversationId })
    mockGetMessageCount.mockResolvedValue(50)
    mockGetMessagesByConversation.mockResolvedValue([
      { role: "user", parts: [{ type: "text", text: "Recent question" }], content: null },
    ])

    await buildInstructionFromConversation(testConversationId, testCognitoSub)

    // Should request offset 30 (50 - 20 = 30) to get the last 20 messages
    expect(mockGetMessagesByConversation).toHaveBeenCalledWith(
      testConversationId,
      expect.objectContaining({ limit: 20, offset: 30 }),
    )
  })

  it("should skip non-text message parts", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue({ id: testConversationId })
    mockGetMessageCount.mockResolvedValue(2)
    mockGetMessagesByConversation.mockResolvedValue([
      {
        role: "user",
        parts: [
          { type: "image", imageUrl: "https://example.com/img.png" },
          { type: "text", text: "What is this?" },
        ],
        content: null,
      },
      {
        role: "assistant",
        parts: [
          { type: "tool-call", toolName: "analyze_image", toolCallId: "1" },
          { type: "text", text: "This appears to be a plant." },
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
    mockGetMessageCount.mockResolvedValue(1)
    mockGetMessagesByConversation.mockResolvedValue([
      { role: "user", parts: null, content: "Plain text message" },
    ])

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).toContain("User: Plain text message")
  })

  it("should skip system messages", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue({ id: testConversationId })
    mockGetMessageCount.mockResolvedValue(2)
    mockGetMessagesByConversation.mockResolvedValue([
      { role: "system", parts: [{ type: "text", text: "System prompt" }], content: null },
      { role: "user", parts: [{ type: "text", text: "Hello" }], content: null },
    ])

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).not.toContain("System prompt")
    expect(result).toContain("User: Hello")
  })

  it("should truncate instruction to 10K characters", async () => {
    mockGetUserIdByCognitoSub.mockResolvedValue("42")
    mockGetConversationById.mockResolvedValue({ id: testConversationId })
    mockGetMessageCount.mockResolvedValue(20)

    // Create messages that would exceed 10K
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text" as const, text: `Message ${i}: ${"X".repeat(1000)}` }],
      content: null,
    }))
    mockGetMessagesByConversation.mockResolvedValue(messages)

    const result = await buildInstructionFromConversation(testConversationId, testCognitoSub)

    expect(result).toBeDefined()
    expect(result!.length).toBeLessThanOrEqual(10_000)
  })
})
