import {
  createNexusMemoryAutoExtractionRunner,
} from "@/lib/nexus/memory/auto-extraction"
import {
  createMemoryService,
} from "@/lib/nexus/memory/memory-service"
import type {
  MemoryRepository,
  StoredNexusMemory,
} from "@/lib/nexus/memory/memory-repository"

const NOW = new Date("2026-07-28T12:00:00.000Z")
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222"

function storedMemory(
  overrides: Partial<StoredNexusMemory> = {},
): StoredNexusMemory {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: 7,
    content: "Prefers concise answers",
    category: "preference",
    source: "auto",
    sourceConversationId: CONVERSATION_ID,
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
    conversationIsOwned: jest.fn().mockResolvedValue(true),
  }
}

describe("Nexus automatic memory onFinish integration", () => {
  it("turns a fact-bearing exchange into an auto row through safety and logs counts", async () => {
    const events: string[] = []
    const repository = createRepository()
    repository.saveWithDedup.mockImplementation(async (record) => {
      events.push("storage")
      expect(record).toMatchObject({
        userId: 7,
        content: "Prefers concise answers",
        category: "preference",
        source: "auto",
        sourceConversationId: CONVERSATION_ID,
      })
      return {
        memory: storedMemory({ content: record.content }),
        action: "inserted",
      }
    })
    const service = createMemoryService({
      repository,
      processInput: jest.fn(async (content) => {
        events.push("safety")
        return {
          allowed: true,
          processedContent: content,
          piiScanCompleted: true,
        }
      }),
      generateEmbedding: jest.fn(async () => {
        events.push("embedding")
        return [0.1, 0.2]
      }),
      getSetting: jest.fn(async () => null),
    })
    const info = jest.fn()
    const runner = createNexusMemoryAutoExtractionRunner({
      resolveAvailability: jest.fn().mockResolvedValue({
        enabled: true,
        reason: "enabled",
      }),
      createModel: jest.fn().mockResolvedValue({
        extract: jest.fn().mockResolvedValue([
          {
            content: "Prefers concise answers",
            category: "preference",
          },
        ]),
        consolidate: jest.fn().mockResolvedValue({
          action: "ADD",
          content: "Prefers concise answers",
          category: "preference",
        }),
      }),
      findSimilar: jest.fn().mockResolvedValue([]),
      service,
      createLog: () => ({ info, error: jest.fn() }),
    })

    await expect(
      runner({
        userId: 7,
        cognitoSub: "cognito-sub",
        conversationId: CONVERSATION_ID,
        requestId: "request-1",
        userMessage:
          "One durable preference: please keep your answers concise.",
        assistantMessage: "Understood.",
      }),
    ).resolves.toEqual({
      extracted: 1,
      added: 1,
      updated: 0,
      deleted: 0,
      noop: 0,
    })

    expect(events).toEqual(["safety", "embedding", "storage"])
    expect(info).toHaveBeenCalledWith(
      "Nexus memory auto-extraction completed",
      {
        conversationId: CONVERSATION_ID,
        extracted: 1,
        added: 1,
        updated: 0,
        deleted: 0,
        noop: 0,
      },
    )
  })
})

describe("Nexus automatic memory update integration", () => {
  it("re-screens and re-embeds an auto-consolidated UPDATE for the owner", async () => {
    const events: string[] = []
    const repository = createRepository()
    repository.updateOwned.mockImplementation(
      async (memoryId, userId, record) => {
        events.push("storage")
        expect(memoryId).toBe(
          "11111111-1111-4111-8111-111111111111",
        )
        expect(userId).toBe(7)
        expect(record).toEqual({
          content: "Prefers concise answers with a summary",
          category: "preference",
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
      processInput: jest.fn(async (content) => {
        events.push("safety")
        return {
          allowed: true,
          processedContent: content,
          piiScanCompleted: true,
        }
      }),
      generateEmbedding: jest.fn(async () => {
        events.push("embedding")
        return [0.3, 0.7]
      }),
      getSetting: jest.fn(async () => null),
    })
    const existing = {
      ...storedMemory({ source: "tool" }),
      similarity: 0.94,
    }
    const runner = createNexusMemoryAutoExtractionRunner({
      resolveAvailability: jest.fn().mockResolvedValue({
        enabled: true,
        reason: "enabled",
      }),
      createModel: jest.fn().mockResolvedValue({
        extract: jest.fn().mockResolvedValue([
          {
            content: "Prefers concise answers with a summary",
            category: "preference",
          },
        ]),
        consolidate: jest.fn().mockResolvedValue({
          action: "UPDATE",
          memoryId: existing.id,
          content: "Prefers concise answers with a summary",
          category: "preference",
        }),
      }),
      findSimilar: jest.fn().mockResolvedValue([existing]),
      service,
      createLog: () => ({ info: jest.fn(), error: jest.fn() }),
    })

    await expect(
      runner({
        userId: 7,
        cognitoSub: "cognito-sub",
        conversationId: CONVERSATION_ID,
        requestId: "request-2",
        userMessage:
          "Please keep answers concise and include a short summary.",
        assistantMessage: "Understood.",
      }),
    ).resolves.toMatchObject({
      extracted: 1,
      added: 0,
      updated: 1,
      deleted: 0,
      noop: 0,
    })

    expect(events).toEqual(["safety", "embedding", "storage"])
  })
})
