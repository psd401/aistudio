import {
  AutoMemoryConsolidationToolInputSchema,
  createNexusMemoryAutoExtractionRunner,
  MIN_AUTO_EXTRACTION_USER_CHARS,
  parseAutoMemoryCandidates,
  parseAutoMemoryConsolidationDecision,
  scheduleNexusMemoryAutoExtraction,
  type AutoMemoryCandidate,
  type AutoMemoryConsolidationDecision,
  type NexusMemoryAutoExtractionInput,
  type NexusMemoryAutoExtractionResult,
} from "@/lib/nexus/memory/auto-extraction"
import type {
  SimilarNexusMemory,
  StoredNexusMemory,
} from "@/lib/nexus/memory/memory-repository"
import type {
  NexusMemoryService,
} from "@/lib/nexus/memory/memory-service"

const INPUT: NexusMemoryAutoExtractionInput = {
  userId: 7,
  cognitoSub: "cognito-sub",
  conversationId: "22222222-2222-4222-8222-222222222222",
  requestId: "request-1",
  userMessage: "I prefer concise answers with a short summary.",
  assistantMessage: "I can keep future answers concise.",
}

const NOW = new Date("2026-07-28T12:00:00.000Z")

function storedMemory(
  overrides: Partial<StoredNexusMemory> = {},
): StoredNexusMemory {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: 7,
    content: "Prefers concise answers",
    category: "preference",
    source: "auto",
    sourceConversationId: INPUT.conversationId,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function similarMemory(
  overrides: Partial<SimilarNexusMemory> = {},
): SimilarNexusMemory {
  return {
    ...storedMemory(),
    similarity: 0.93,
    ...overrides,
  }
}

function createService(): jest.Mocked<
  Pick<NexusMemoryService, "save" | "update" | "forget">
> {
  return {
    save: jest.fn().mockResolvedValue({
      memory: storedMemory(),
      action: "inserted",
    }),
    update: jest.fn().mockResolvedValue(storedMemory()),
    forget: jest.fn().mockResolvedValue(true),
  }
}

function createRunner(options: {
  enabled?: boolean
  reason?:
    | "enabled"
    | "global-disabled"
    | "capability-denied"
    | "user-disabled"
    | "conversation-disabled"
    | "conversation-not-found"
    | "gate-error"
  candidates?: AutoMemoryCandidate[]
  decisions?: AutoMemoryConsolidationDecision[]
  neighbors?: SimilarNexusMemory[]
  service?: jest.Mocked<
    Pick<NexusMemoryService, "save" | "update" | "forget">
  >
  info?: jest.Mock
}) {
  const decisions = [...(options.decisions ?? [])]
  const service = options.service ?? createService()
  const extract = jest.fn().mockResolvedValue(options.candidates ?? [])
  const consolidate = jest.fn().mockImplementation(async () => {
    const decision = decisions.shift()
    if (!decision) throw new Error("Missing test consolidation decision")
    return decision
  })
  const info = options.info ?? jest.fn()
  const runner = createNexusMemoryAutoExtractionRunner({
    resolveAvailability: jest.fn().mockResolvedValue({
      enabled: options.enabled ?? true,
      reason: options.reason ?? "enabled",
    }),
    createModel: jest.fn().mockResolvedValue({
      extract,
      consolidate,
    }),
    findSimilar: jest.fn().mockResolvedValue(options.neighbors ?? []),
    service,
    createLog: () => ({ info, error: jest.fn() }),
  })
  return { runner, service, extract, consolidate, info }
}

describe("Nexus automatic memory model output", () => {
  it("uses a Bedrock-compatible object schema for consolidation tools", () => {
    expect(
      AutoMemoryConsolidationToolInputSchema.safeParse({
        action: "UPDATE",
        memoryId: "2406c346-12ae-4a85-987b-a3e170ae8fb0",
        content: "Works in education",
        category: "profile",
      }).success,
    ).toBe(true)
  })

  it("parses forced candidate and consolidation tool calls", () => {
    expect(
      parseAutoMemoryCandidates({
        text: "",
        toolCalls: [
          {
            toolName: "submit_auto_memory_candidates",
            input: {
              candidates: [
                {
                  content: "Works in education",
                  category: "profile",
                },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      {
        content: "Works in education",
        category: "profile",
      },
    ])

    expect(
      parseAutoMemoryConsolidationDecision({
        text: "",
        toolCalls: [
          {
            toolName: "submit_memory_consolidation_decision",
            input: { action: "NOOP" },
          },
        ],
      }),
    ).toEqual({ action: "NOOP" })
  })

  it("rejects malformed extraction and consolidation output", () => {
    expect(() =>
      parseAutoMemoryCandidates({ text: "not json", toolCalls: [] }),
    ).toThrow("invalid response")
    expect(() =>
      parseAutoMemoryConsolidationDecision({
        text: JSON.stringify({
          action: "UPDATE",
          memoryId: "not-a-uuid",
        }),
        toolCalls: [],
      }),
    ).toThrow("invalid response")
  })
})

describe("Nexus automatic memory gates", () => {
  it.each([
    "global-disabled",
    "capability-denied",
    "user-disabled",
    "conversation-disabled",
  ] as const)("skips model and writes when the %s gate is closed", async (reason) => {
    const { runner, service, extract } = createRunner({
      enabled: false,
      reason,
    })

    await expect(runner(INPUT)).resolves.toMatchObject({
      extracted: 0,
      added: 0,
      updated: 0,
      deleted: 0,
      noop: 0,
      skippedReason: reason,
    })
    expect(extract).not.toHaveBeenCalled()
    expect(service.save).not.toHaveBeenCalled()
    expect(service.update).not.toHaveBeenCalled()
    expect(service.forget).not.toHaveBeenCalled()
  })

  it("skips trivially short user messages before loading the model", async () => {
    const { runner, service, extract } = createRunner({})

    await expect(
      runner({
        ...INPUT,
        userMessage: "x".repeat(MIN_AUTO_EXTRACTION_USER_CHARS - 1),
      }),
    ).resolves.toMatchObject({ skippedReason: "short-message" })
    expect(extract).not.toHaveBeenCalled()
    expect(service.save).not.toHaveBeenCalled()
  })
})

describe("Nexus automatic memory consolidation", () => {
  it("applies ADD, UPDATE, DELETE, and NOOP through owner-scoped service methods", async () => {
    const existing = similarMemory()
    const candidates: AutoMemoryCandidate[] = [
      { content: "New context", category: "context" },
      { content: "Updated preference", category: "preference" },
      { content: "No longer relevant", category: "context" },
      { content: "Duplicate preference", category: "preference" },
    ]
    const decisions: AutoMemoryConsolidationDecision[] = [
      {
        action: "ADD",
        content: "Works on a curriculum review project",
        category: "context",
      },
      {
        action: "UPDATE",
        memoryId: existing.id,
        content: "Prefers concise answers with a summary",
        category: "preference",
      },
      { action: "DELETE", memoryId: existing.id },
      { action: "NOOP" },
    ]
    const { runner, service } = createRunner({
      candidates,
      decisions,
      neighbors: [existing],
    })

    await expect(runner(INPUT)).resolves.toEqual({
      extracted: 4,
      added: 1,
      updated: 1,
      deleted: 1,
      noop: 1,
    })
    expect(service.save).toHaveBeenCalledWith({
      userId: 7,
      sessionId: INPUT.cognitoSub,
      content: "Works on a curriculum review project",
      category: "context",
      source: "auto",
      sourceConversationId: INPUT.conversationId,
    })
    expect(service.update).toHaveBeenCalledWith({
      memoryId: existing.id,
      userId: 7,
      sessionId: INPUT.cognitoSub,
      content: "Prefers concise answers with a summary",
      category: "preference",
    })
    expect(service.forget).toHaveBeenCalledWith(existing.id, 7)
  })

  it.each(["UPDATE", "DELETE"] as const)(
    "rejects a model-selected %s target outside the owner's neighbors",
    async (action) => {
      const foreignId = "99999999-9999-4999-8999-999999999999"
      const decision: AutoMemoryConsolidationDecision =
        action === "UPDATE"
          ? {
              action,
              memoryId: foreignId,
              content: "Forged update",
              category: "context",
            }
          : { action, memoryId: foreignId }
      const { runner, service } = createRunner({
        candidates: [
          { content: "Candidate fact", category: "context" },
        ],
        decisions: [decision],
        neighbors: [similarMemory()],
      })

      await expect(runner(INPUT)).resolves.toMatchObject({ noop: 1 })
      expect(service.update).not.toHaveBeenCalled()
      expect(service.forget).not.toHaveBeenCalled()
    },
  )
})

describe("Nexus automatic memory scheduling", () => {
  it("returns immediately and logs a rejected extraction without surfacing it", async () => {
    let rejectRun: ((reason: Error) => void) | undefined
    const run = jest.fn(
      () =>
        new Promise<NexusMemoryAutoExtractionResult>((_resolve, reject) => {
          rejectRun = reject
        }),
    )
    const error = jest.fn()

    expect(
      scheduleNexusMemoryAutoExtraction(INPUT, {
        run,
        createLog: () => ({ info: jest.fn(), error }),
      }),
    ).toBeUndefined()
    expect(run).toHaveBeenCalledWith(INPUT)

    rejectRun?.(new Error("extraction provider failed"))
    await Promise.resolve()
    await Promise.resolve()

    expect(error).toHaveBeenCalledWith(
      "Nexus memory auto-extraction failed",
      expect.objectContaining({
        conversationId: INPUT.conversationId,
        error: "extraction provider failed",
      }),
    )
  })
})
