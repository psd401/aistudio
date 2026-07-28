import { ContentSafetyBlockedError } from "@/lib/streaming/types"
import { buildMemoryChatTools } from "@/lib/nexus/memory/memory-tools"
import type { NexusMemoryService } from "@/lib/nexus/memory/memory-service"

type ExecutableTool = {
  execute: (args: unknown, options?: unknown) => Promise<unknown>
}

function executeTool(tool: unknown, args: unknown): Promise<unknown> {
  return (tool as ExecutableTool).execute(args, {})
}

function createService(): jest.Mocked<NexusMemoryService> {
  return {
    save: jest.fn(),
    retrieve: jest.fn(),
    forget: jest.fn(),
  }
}

const INPUT = {
  userId: 7,
  cognitoSub: "cognito-sub",
  conversationId: "22222222-2222-4222-8222-222222222222",
  requestId: "request-1",
}

describe("Nexus memory tools", () => {
  it("builds the prompt fragment only from memories owned by the bound user", () => {
    const service = createService()
    const owned = {
      id: "11111111-1111-4111-8111-111111111111",
      userId: 7,
      content: "Prefers concise answers",
      category: "preference" as const,
      source: "tool" as const,
      sourceConversationId: INPUT.conversationId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const foreign = {
      ...owned,
      id: "44444444-4444-4444-8444-444444444444",
      userId: 8,
      content: "Foreign secret",
    }

    const result = buildMemoryChatTools(
      { ...INPUT, memories: [owned, foreign] },
      {
        service,
        resolveAvailability: jest.fn(),
      },
    )

    expect(result.systemPromptFragment).toContain("Prefers concise answers")
    expect(result.systemPromptFragment).not.toContain("Foreign secret")
  })

  it("rechecks all gates at execution time and performs no write when disabled", async () => {
    const service = createService()
    const { tools } = buildMemoryChatTools(INPUT, {
      service,
      resolveAvailability: jest.fn(async () => ({
        enabled: false,
        reason: "conversation-disabled" as const,
      })),
    })

    await expect(
      executeTool(tools.saveMemory, {
        content: "Remember this",
        category: "context",
      }),
    ).resolves.toEqual({
      error: "Memory is disabled for this conversation.",
    })
    expect(service.save).not.toHaveBeenCalled()
  })

  it("binds save writes to the authenticated owner and current conversation", async () => {
    const service = createService()
    service.save.mockResolvedValue({
      action: "inserted",
      memory: {
        id: "11111111-1111-4111-8111-111111111111",
        userId: 7,
        content: "Prefers concise answers",
        category: "preference",
        source: "tool",
        sourceConversationId: INPUT.conversationId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
    const { tools } = buildMemoryChatTools(INPUT, {
      service,
      resolveAvailability: jest.fn(async () => ({
        enabled: true,
        reason: "enabled" as const,
      })),
    })

    await expect(
      executeTool(tools.saveMemory, {
        content: "Prefers concise answers",
        category: "preference",
      }),
    ).resolves.toEqual({
      ok: true,
      memoryId: "11111111-1111-4111-8111-111111111111",
      action: "inserted",
    })
    expect(service.save).toHaveBeenCalledWith({
      userId: 7,
      sessionId: "cognito-sub",
      content: "Prefers concise answers",
      category: "preference",
      source: "tool",
      sourceConversationId: INPUT.conversationId,
    })
  })

  it("returns a safe tool error and does not mask a safety block as success", async () => {
    const service = createService()
    service.save.mockRejectedValue(
      new ContentSafetyBlockedError("Memory blocked", ["policy"], "input"),
    )
    const { tools } = buildMemoryChatTools(INPUT, {
      service,
      resolveAvailability: jest.fn(async () => ({
        enabled: true,
        reason: "enabled" as const,
      })),
    })

    await expect(
      executeTool(tools.saveMemory, {
        content: "blocked",
        category: "context",
      }),
    ).resolves.toEqual({ error: "Memory blocked" })
  })

  it("binds forget to the authenticated owner so foreign ids are not deleted", async () => {
    const service = createService()
    service.forget.mockResolvedValue(false)
    const { tools } = buildMemoryChatTools(INPUT, {
      service,
      resolveAvailability: jest.fn(async () => ({
        enabled: true,
        reason: "enabled" as const,
      })),
    })

    const memoryId = "33333333-3333-4333-8333-333333333333"
    await expect(
      executeTool(tools.forgetMemory, { memoryId }),
    ).resolves.toEqual({ error: "Memory not found." })
    expect(service.forget).toHaveBeenCalledWith(memoryId, 7)
  })
})
