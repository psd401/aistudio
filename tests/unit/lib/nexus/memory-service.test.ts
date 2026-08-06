/* eslint-disable no-var */
var mockLogInfo = jest.fn()
/* eslint-enable no-var */

// createLogger runs at module load, which is hoisted above this assignment,
// so the methods must dereference lazily.
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: () => "request-1",
  startTimer: () => jest.fn(),
  sanitizeForLogging: (value: unknown) => value,
  getLogContext: () => ({}),
}))

import { ContentSafetyBlockedError } from "@/lib/streaming/types"
import {
  createMemoryService,
  MEMORY_DEDUP_THRESHOLD,
  MAX_PROFILE_MEMORIES_PER_TURN,
} from "@/lib/nexus/memory/memory-service"
import type {
  MemoryRepository,
  StoredNexusMemory,
} from "@/lib/nexus/memory/memory-repository"

const NOW = new Date("2026-07-27T12:00:00.000Z")

function storedMemory(
  overrides: Partial<StoredNexusMemory> = {},
): StoredNexusMemory {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: 7,
    content: "Prefers concise answers",
    category: "preference",
    source: "tool",
    sourceConversationId: "22222222-2222-4222-8222-222222222222",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function createRepository(): jest.Mocked<MemoryRepository> {
  return {
    saveWithDedup: jest.fn(),
    updateOwned: jest.fn(),
    listProfileMemories: jest.fn(),
    findRelevantMemories: jest.fn(),
    findSimilarMemories: jest.fn(),
    softDeleteOwned: jest.fn(),
    conversationIsOwned: jest.fn(),
  }
}

describe("Nexus memory service", () => {
  it("screens and sanitizes every write before ownership, embedding, and storage", async () => {
    const events: string[] = []
    const repository = createRepository()
    repository.conversationIsOwned.mockImplementation(async () => {
      events.push("ownership")
      return true
    })
    repository.saveWithDedup.mockImplementation(async (record, threshold) => {
      events.push("storage")
      expect(record.content).toBe("sanitized content")
      expect(record.userId).toBe(7)
      expect(threshold).toBe(MEMORY_DEDUP_THRESHOLD)
      return { memory: storedMemory({ content: record.content }), action: "inserted" }
    })
    const processInput = jest.fn(async () => {
      events.push("safety")
      return {
        allowed: true,
        processedContent: "sanitized content",
      }
    })
    const detectPII = jest.fn(async () => {
      events.push("pii")
      return []
    })
    const generateEmbedding = jest.fn(async () => {
      events.push("embedding")
      return [0.1, 0.2]
    })
    const service = createMemoryService({
      repository,
      processInput,
      detectPII,
      generateEmbedding,
      getSetting: jest.fn(async () => null),
    })

    await service.save({
      userId: 7,
      sessionId: "cognito-sub",
      content: " raw private content ",
      category: "preference",
      source: "tool",
      sourceConversationId: "22222222-2222-4222-8222-222222222222",
    })

    expect(events).toEqual(["safety", "pii", "ownership", "embedding", "storage"])
    expect(processInput).toHaveBeenCalledWith(
      "raw private content",
      "cognito-sub",
    )
  })

  it("does not perform database or embedding work when safety blocks a write", async () => {
    const repository = createRepository()
    const generateEmbedding = jest.fn(async () => [0.1])
    const service = createMemoryService({
      repository,
      processInput: jest.fn(async () => ({
        allowed: false,
        processedContent: "",
        blockedMessage: "Blocked by policy",
        blockedCategories: ["prompt_attack"],
      })),
      detectPII: jest.fn(async () => []),
      generateEmbedding,
      getSetting: jest.fn(async () => null),
    })

    await expect(
      service.save({
        userId: 7,
        sessionId: "cognito-sub",
        content: "unsafe",
        category: "context",
        source: "tool",
      }),
    ).rejects.toBeInstanceOf(ContentSafetyBlockedError)
    expect(repository.conversationIsOwned).not.toHaveBeenCalled()
    expect(generateEmbedding).not.toHaveBeenCalled()
    expect(repository.saveWithDedup).not.toHaveBeenCalled()
  })

  it("rejects a source conversation that is not owned by the memory owner", async () => {
    const repository = createRepository()
    repository.conversationIsOwned.mockResolvedValue(false)
    const generateEmbedding = jest.fn(async () => [0.1])
    const service = createMemoryService({
      repository,
      processInput: jest.fn(async (content) => ({
        allowed: true,
        processedContent: content,
      })),
      detectPII: jest.fn(async () => []),
      generateEmbedding,
      getSetting: jest.fn(async () => null),
    })

    await expect(
      service.save({
        userId: 7,
        sessionId: "cognito-sub",
        content: "remember this",
        category: "context",
        source: "tool",
        sourceConversationId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toThrow("source conversation not found")
    expect(generateEmbedding).not.toHaveBeenCalled()
    expect(repository.saveWithDedup).not.toHaveBeenCalled()
  })
})

describe("Nexus memory service edits", () => {
  it("re-screens and re-embeds edited content before owner-scoped storage", async () => {
    const events: string[] = []
    const repository = createRepository()
    repository.updateOwned.mockImplementation(
      async (memoryId, userId, record) => {
        events.push("storage")
        expect(memoryId).toBe("11111111-1111-4111-8111-111111111111")
        expect(userId).toBe(7)
        expect(record).toEqual({
          content: "sanitized edit",
          category: "profile",
          embedding: [0.3, 0.7],
        })
        return storedMemory({
          content: record.content,
          category: record.category,
        })
      },
    )
    const service = createMemoryService({
      repository,
      processInput: jest.fn(async () => {
        events.push("safety")
        return {
          allowed: true,
          processedContent: "sanitized edit",
        }
      }),
      detectPII: jest.fn(async () => []),
      generateEmbedding: jest.fn(async () => {
        events.push("embedding")
        return [0.3, 0.7]
      }),
      getSetting: jest.fn(async () => null),
    })

    await expect(
      service.update({
        memoryId: "11111111-1111-4111-8111-111111111111",
        userId: 7,
        sessionId: "cognito-sub",
        content: " raw edited content ",
        category: "profile",
      }),
    ).resolves.toMatchObject({
      content: "sanitized edit",
      category: "profile",
    })
    expect(events).toEqual(["safety", "embedding", "storage"])
  })
})

describe("Nexus memory personal information handling", () => {
  // A memory is the user's own record of their own life. Detection is
  // telemetry; it must never cost the user the write.
  it("stores personal information instead of refusing it", async () => {
    const content = "Wife Sarah teaches third grade at Harbor Ridge"
    const repository = createRepository()
    repository.saveWithDedup.mockResolvedValue({
      memory: storedMemory({ content, category: "profile" }),
      action: "inserted",
    })
    const generateEmbedding = jest.fn(async () => [0.1])
    const detectPII = jest.fn(async () => [
      { type: "NAME", beginOffset: 5, endOffset: 10, score: 0.999 },
      { type: "ADDRESS", beginOffset: 31, endOffset: 44, score: 0.98 },
    ])
    const service = createMemoryService({
      repository,
      processInput: jest.fn(async (raw: string) => ({
        allowed: true,
        processedContent: raw,
      })),
      detectPII,
      generateEmbedding,
      getSetting: jest.fn(async () => null),
    })

    await expect(
      service.save({
        userId: 7,
        sessionId: "cognito-sub",
        content,
        category: "profile",
        source: "import:chatgpt",
      }),
    ).resolves.toMatchObject({ action: "inserted" })
    expect(detectPII).toHaveBeenCalledTimes(1)
    expect(generateEmbedding).toHaveBeenCalledWith(content)
    expect(repository.saveWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ content }),
      MEMORY_DEDUP_THRESHOLD,
    )
  })

  // Auto-extraction runs unattended, and its prompt is the only thing keeping
  // third-party identifiers out of it. Tagging the telemetry with the source
  // is what makes "the prompt did not hold" a query rather than a guess.
  it("tags the detection telemetry with the write's source", async () => {
    const repository = createRepository()
    repository.saveWithDedup.mockResolvedValue({
      memory: storedMemory({ content: "Student Ellie is 8", source: "auto" }),
      action: "inserted",
    })
    const service = createMemoryService({
      repository,
      processInput: jest.fn(async (raw: string) => ({
        allowed: true,
        processedContent: raw,
      })),
      detectPII: jest.fn(async () => [
        { type: "AGE", beginOffset: 16, endOffset: 17, score: 0.99 },
      ]),
      generateEmbedding: jest.fn(async () => [0.1]),
      getSetting: jest.fn(async () => null),
    })

    await service.save({
      userId: 7,
      sessionId: "cognito-sub",
      content: "Student Ellie is 8",
      category: "context",
      source: "auto",
    })

    expect(mockLogInfo).toHaveBeenCalledWith(
      "Nexus memory contains detected personal information",
      expect.objectContaining({
        userId: 7,
        source: "auto",
        piiEntityCount: 1,
        piiTypes: { AGE: 1 },
      }),
    )
  })
})

describe("Nexus memory privacy scan availability", () => {
  it("saves when the detect-only privacy scan is unavailable", async () => {
    const repository = createRepository()
    repository.saveWithDedup.mockResolvedValue({
      memory: storedMemory({ content: "Was not conclusively screened" }),
      action: "inserted",
    })
    const generateEmbedding = jest.fn(async () => [0.1])
    const service = createMemoryService({
      repository,
      processInput: jest.fn(async (content: string) => ({
        allowed: true,
        processedContent: content,
      })),
      detectPII: jest.fn(async () => {
        throw new Error("Comprehend unavailable")
      }),
      generateEmbedding,
      getSetting: jest.fn(async () => null),
    })

    await expect(
      service.save({
        userId: 7,
        sessionId: "cognito-sub",
        content: "Was not conclusively screened",
        category: "context",
        source: "tool",
      }),
    ).resolves.toMatchObject({ action: "inserted" })
    expect(generateEmbedding).toHaveBeenCalledTimes(1)
    expect(repository.saveWithDedup).toHaveBeenCalledTimes(1)
  })

  it("still refuses content the safety gate blocks", async () => {
    const repository = createRepository()
    const service = createMemoryService({
      repository,
      processInput: jest.fn(async () => ({
        allowed: false,
        processedContent: "",
        blockedMessage: "Blocked by policy",
        blockedCategories: ["prompt_attack"],
      })),
      detectPII: jest.fn(async () => []),
      generateEmbedding: jest.fn(async () => [0.1]),
      getSetting: jest.fn(async () => null),
    })

    await expect(
      service.save({
        userId: 7,
        sessionId: "cognito-sub",
        content: "unsafe",
        category: "context",
        source: "import:claude",
      }),
    ).rejects.toBeInstanceOf(ContentSafetyBlockedError)
    expect(repository.saveWithDedup).not.toHaveBeenCalled()
  })
})

describe("Nexus memory service retrieval and deletion", () => {
  it("excludes newest profiles before ranking older relevant memories", async () => {
    const repository = createRepository()
    const profile = storedMemory({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", category: "profile" })
    const olderProfile = storedMemory({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      category: "profile",
      content: "Previously lived in Oregon",
    })
    const relevant = storedMemory({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })
    repository.listProfileMemories.mockResolvedValue([profile])
    repository.findRelevantMemories.mockResolvedValue([
      profile,
      olderProfile,
      relevant,
    ])
    const getSetting = jest.fn(async (key: string) =>
      key === "MEMORY_RETRIEVAL_THRESHOLD" ? "0.42" : "9",
    )
    const service = createMemoryService({
      repository,
      processInput: jest.fn(),
      detectPII: jest.fn(),
      generateEmbedding: jest.fn(async () => [0.5, 0.5]),
      getSetting,
    })

    await expect(service.retrieve({ userId: 7, query: "current topic" }))
      .resolves.toEqual([profile, olderProfile, relevant])
    expect(repository.listProfileMemories).toHaveBeenCalledWith(
      7,
      MAX_PROFILE_MEMORIES_PER_TURN,
    )
    expect(repository.findRelevantMemories).toHaveBeenCalledWith(
      7,
      [0.5, 0.5],
      0.42,
      9,
      [profile.id],
    )
  })

  it("fails open when retrieval infrastructure is unavailable", async () => {
    const repository = createRepository()
    const profile = storedMemory({ category: "profile" })
    repository.listProfileMemories.mockResolvedValue([profile])
    const service = createMemoryService({
      repository,
      processInput: jest.fn(),
      detectPII: jest.fn(),
      generateEmbedding: jest.fn(async () => {
        throw new Error("Bedrock unavailable")
      }),
      getSetting: jest.fn(async () => null),
    })

    await expect(service.retrieve({ userId: 7, query: "hello" }))
      .resolves.toEqual([profile])
    expect(repository.findRelevantMemories).not.toHaveBeenCalled()
  })

  it("injects profile memory without embedding an empty user message", async () => {
    const repository = createRepository()
    const profile = storedMemory({ category: "profile" })
    const generateEmbedding = jest.fn()
    repository.listProfileMemories.mockResolvedValue([profile])
    const service = createMemoryService({
      repository,
      processInput: jest.fn(),
      detectPII: jest.fn(),
      generateEmbedding,
      getSetting: jest.fn(),
    })

    await expect(service.retrieve({ userId: 7, query: "  " }))
      .resolves.toEqual([profile])
    expect(generateEmbedding).not.toHaveBeenCalled()
  })

  it("scopes forget operations to the authenticated numeric owner", async () => {
    const repository = createRepository()
    repository.softDeleteOwned.mockResolvedValue(true)
    const service = createMemoryService({
      repository,
      processInput: jest.fn(),
      detectPII: jest.fn(),
      generateEmbedding: jest.fn(),
      getSetting: jest.fn(),
    })

    await expect(
      service.forget("11111111-1111-4111-8111-111111111111", 7),
    ).resolves.toBe(true)
    expect(repository.softDeleteOwned).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      7,
    )
  })
})
