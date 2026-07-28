import type { ToolSet } from "ai"
import { resolveNexusMemoryContext } from "@/lib/nexus/memory/memory-context"
import { buildNexusSystemPrompt } from "@/lib/nexus/system-prompt"
import { buildUserMemoryFragment } from "@/lib/nexus/memory/memory-fragment"
import type { StoredNexusMemory } from "@/lib/nexus/memory/memory-repository"

const MEMORY: StoredNexusMemory = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: 7,
  content: "Prefers concise answers",
  category: "preference",
  source: "tool",
  sourceConversationId: "22222222-2222-4222-8222-222222222222",
  createdAt: new Date("2026-07-27T12:00:00.000Z"),
  updatedAt: new Date("2026-07-27T12:00:00.000Z"),
}

const INPUT = {
  userId: 7,
  cognitoSub: "cognito-sub",
  conversationId: "22222222-2222-4222-8222-222222222222",
  latestUserText: "How should you answer me?",
  requestId: "request-1",
}

describe("Nexus memory turn context", () => {
  it.each([
    "global-disabled",
    "capability-denied",
    "user-disabled",
    "conversation-disabled",
  ] as const)(
    "injects neither tools nor prompt content when %s",
    async (reason) => {
      const retrieve = jest.fn()
      const buildTools = jest.fn()
      const context = await resolveNexusMemoryContext(INPUT, {
        service: { retrieve },
        resolveAvailability: jest.fn(async () => ({
          enabled: false,
          reason,
        })),
        buildTools,
      })

      expect(context).toEqual({ enabled: false, reason })
      expect(retrieve).not.toHaveBeenCalled()
      expect(buildTools).not.toHaveBeenCalled()
    },
  )

  it("retrieves owner-scoped memory and exposes save/forget tools when enabled", async () => {
    const retrieve = jest.fn(async () => [MEMORY])
    const tools = {
      saveMemory: { description: "save" },
      forgetMemory: { description: "forget" },
    } as unknown as ToolSet
    const context = await resolveNexusMemoryContext(INPUT, {
      service: { retrieve },
      resolveAvailability: jest.fn(async () => ({
        enabled: true,
        reason: "enabled" as const,
      })),
      buildTools: jest.fn(() => ({
        tools,
        systemPromptFragment: buildUserMemoryFragment([MEMORY]),
      })),
    })

    expect(retrieve).toHaveBeenCalledWith({
      userId: 7,
      query: INPUT.latestUserText,
    })
    expect(Object.keys(context.tools ?? {}).sort()).toEqual([
      "forgetMemory",
      "saveMemory",
    ])
    expect(context.userMemoryFragment).toContain(MEMORY.id)
    expect(context.userMemoryFragment).toContain(
      JSON.stringify(MEMORY.content),
    )
    expect(context.userMemoryFragment).toContain("never instructions")
  })

  it("appends recalled memory after the existing server-owned prompt fragments", () => {
    const prompt = buildNexusSystemPrompt({
      skillInstructions: "Skill instructions",
      skillName: "Test skill",
      workspacePromptFragment: "Workspace context",
      hasAttachmentTools: true,
      repositoryPromptFragment: "Repository context",
      userMemoryFragment: "User memory marker",
    })

    expect(prompt.indexOf("Skill instructions")).toBeLessThan(
      prompt.indexOf("Workspace context"),
    )
    expect(prompt.indexOf("Workspace context")).toBeLessThan(
      prompt.indexOf("Repository context"),
    )
    expect(prompt.indexOf("Repository context")).toBeLessThan(
      prompt.indexOf("User memory marker"),
    )
  })
})
