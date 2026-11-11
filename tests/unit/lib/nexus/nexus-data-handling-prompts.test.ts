/**
 * #2034 (findings 4 and 5): deterministic checks that the exact prompt text the
 * Nexus route and the memory extractor send carries each data-handling rule.
 * The model-behaviour side of the same rules is the live eval,
 * `bun run eval:nexus:privacy` (scripts/eval/nexus-privacy-eval.ts).
 *
 * All people in these fixtures are fictional.
 */
const mockGenerateText = jest.fn()

jest.mock("ai", () => ({
  __esModule: true,
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  tool: (definition: unknown) => definition,
}))

import {
  buildNexusSystemPrompt,
  NEXUS_BASE_SYSTEM_PROMPT,
  NEXUS_DATA_HANDLING_PROMPT,
} from "@/lib/nexus/system-prompt"
import {
  AUTO_CONSOLIDATION_SYSTEM_PROMPT,
  AUTO_EXTRACTION_SYSTEM_PROMPT,
  createNexusMemoryAutoExtractionRunner,
  runExtractionModel,
  USER_ONLY_SCOPE_REMINDER,
} from "@/lib/nexus/memory/auto-extraction"
import {
  buildUserMemoryFragment,
  MEMORY_FRAGMENT_SUFFIX,
} from "@/lib/nexus/memory/memory-fragment"
import type { LanguageModel } from "ai"
import type { StoredNexusMemory } from "@/lib/nexus/memory/memory-repository"

const NOW = new Date("2026-11-11T12:00:00.000Z")

describe("Nexus data-handling system prompt (#2034 finding 4)", () => {
  const promptVariants: Array<[string, string]> = [
    ["a bare chat", buildNexusSystemPrompt({})],
    [
      "a chat with every optional fragment",
      buildNexusSystemPrompt({
        skillInstructions: "Skill instructions",
        skillName: "Test skill",
        workspacePromptFragment: "Workspace context",
        workspacePreviewDiagnosticsFragment: "Preview failures",
        hasAttachmentTools: true,
        repositoryPromptFragment: "Repository context",
        userMemoryFragment: "User memory",
      }),
    ],
  ]

  it.each(promptVariants)("is part of the base prompt on %s", (_label, prompt) => {
    expect(NEXUS_BASE_SYSTEM_PROMPT).toContain(NEXUS_DATA_HANDLING_PROMPT)
    expect(prompt.startsWith(NEXUS_BASE_SYSTEM_PROMPT)).toBe(true)
  })

  it("comes before any loaded skill, so a skill cannot displace it", () => {
    const prompt = buildNexusSystemPrompt({
      skillInstructions: "Skill instructions",
      skillName: "Test skill",
    })
    expect(prompt.indexOf(NEXUS_DATA_HANDLING_PROMPT)).toBeLessThan(
      prompt.indexOf("Skill instructions"),
    )
  })

  it("answers 'can I put student data here' affirmatively", () => {
    expect(NEXUS_DATA_HANDLING_PROMPT).toMatch(
      /approved for district work, including student and staff data/,
    )
    expect(NEXUS_DATA_HANDLING_PROMPT).toMatch(/say yes/)
    expect(NEXUS_DATA_HANDLING_PROMPT).toMatch(
      /Never say Nexus is not a district system/,
    )
  })

  it("forbids suggesting anyone-with-the-link or general access", () => {
    expect(NEXUS_DATA_HANDLING_PROMPT).toMatch(
      /Never suggest changing a Google Doc, Sheet, Slides file, or Drive folder to "anyone with the link"/,
    )
    expect(NEXUS_DATA_HANDLING_PROMPT).toMatch(/general-access sharing setting/)
    expect(NEXUS_DATA_HANDLING_PROMPT).toMatch(/including so that you can read it/)
  })

  it("asks for an attachment or paste when a Google file cannot be read", () => {
    expect(NEXUS_DATA_HANDLING_PROMPT).toMatch(
      /cannot open or read a Google Doc, Sheet, or other file[\s\S]*ask them to attach the file[\s\S]*or paste its contents/,
    )
  })

  it("forbids sending district data to a consumer AI tool", () => {
    expect(NEXUS_DATA_HANDLING_PROMPT).toMatch(
      /Never suggest taking district, student, or staff data to a personal or consumer AI tool/,
    )
    expect(NEXUS_DATA_HANDLING_PROMPT).toMatch(/ChatGPT/)
  })

  it("keeps one student's facts out of writing about another", () => {
    expect(NEXUS_DATA_HANDLING_PROMPT).toMatch(
      /Never carry a detail about one student into writing about a different student/,
    )
  })
})

describe("Nexus memory scope (#2034 finding 5)", () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
  })

  it("asks the extractor for facts about the user only", () => {
    expect(AUTO_EXTRACTION_SYSTEM_PROMPT).toMatch(
      /Every candidate must be a fact about the user themselves/,
    )
    expect(AUTO_EXTRACTION_SYSTEM_PROMPT).toMatch(
      /Never extract facts about anyone other than the user/,
    )
    expect(AUTO_EXTRACTION_SYSTEM_PROMPT).toMatch(
      /Nothing about a student, a parent, a colleague, or any other person may become a candidate/,
    )
    expect(AUTO_EXTRACTION_SYSTEM_PROMPT).toMatch(/recommendation letters/)
  })

  it("sends that prompt to the extraction model", async () => {
    mockGenerateText.mockResolvedValue({
      text: "",
      toolCalls: [
        {
          toolName: "submit_auto_memory_candidates",
          input: { candidates: [] },
        },
      ],
    })

    const candidates = await runExtractionModel(
      {} as LanguageModel,
      {
        userMessage: "Draft a recommendation letter for a fictional senior.",
        assistantMessage: "Here is a draft.",
      },
    )

    expect(candidates).toEqual([])
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    const request = mockGenerateText.mock.calls[0][0] as {
      system: string
      prompt: string
      tools: Record<string, { description: string }>
    }
    expect(request.system).toBe(AUTO_EXTRACTION_SYSTEM_PROMPT)
    // Repeated beside the data and in the tool description: the default
    // extraction model followed the system-prompt rule alone inconsistently.
    expect(request.prompt.endsWith(USER_ONLY_SCOPE_REMINDER)).toBe(true)
    expect(
      request.tools.submit_auto_memory_candidates.description,
    ).toContain(USER_ONLY_SCOPE_REMINDER)
    expect(USER_ONLY_SCOPE_REMINDER).toMatch(
      /No candidate may name or describe a student or any other person/,
    )
  })

  it("has consolidation drop a candidate about someone other than the user", () => {
    expect(AUTO_CONSOLIDATION_SYSTEM_PROMPT).toMatch(
      /NOOP when the candidate names or describes anyone other than the user/,
    )
  })

  it("tells the chat model recalled memories describe the user only", () => {
    const memory: StoredNexusMemory = {
      id: "11111111-1111-4111-8111-111111111111",
      userId: 7,
      content: "Writes college recommendation letters for seniors",
      category: "context",
      source: "auto",
      sourceConversationId: "22222222-2222-4222-8222-222222222222",
      createdAt: NOW,
      updatedAt: NOW,
    }

    const fragment = buildUserMemoryFragment([memory])

    expect(fragment).toBeDefined()
    expect(fragment?.endsWith(MEMORY_FRAGMENT_SUFFIX)).toBe(true)
    expect(MEMORY_FRAGMENT_SUFFIX).toMatch(/These memories describe the user only/)
    expect(MEMORY_FRAGMENT_SUFFIX).toMatch(
      /Never use a recalled memory as a fact about a student or any other person/,
    )
  })

  it("never blocks a memory write on its content: the scope lives in the prompt only", async () => {
    // Standing rule (docs/features/k12-content-safety.md, PII Privacy
    // Boundary): whatever the extractor returns is consolidated and saved.
    // The runner must not grow a name/PII filter as the #2034 fix.
    const candidate = {
      content: "Advises the robotics club with Avery Fictional",
      category: "context" as const,
    }
    const save = jest.fn(async () => ({
      action: "inserted" as const,
      memory: {
        id: "33333333-3333-4333-8333-333333333333",
        userId: 7,
        content: candidate.content,
        category: candidate.category,
        source: "auto" as const,
        sourceConversationId: "22222222-2222-4222-8222-222222222222",
        createdAt: NOW,
        updatedAt: NOW,
      },
    }))
    const run = createNexusMemoryAutoExtractionRunner({
      resolveAvailability: async () => ({ enabled: true, reason: "enabled" }),
      createModel: async () => ({
        extract: async () => [candidate],
        consolidate: async () => ({ action: "ADD", ...candidate }),
      }),
      findSimilar: async () => [],
      service: { save, update: jest.fn(), forget: jest.fn() },
      createLog: () => ({ info: jest.fn(), error: jest.fn() }),
    })

    const result = await run({
      userId: 7,
      cognitoSub: "cognito-sub",
      conversationId: "22222222-2222-4222-8222-222222222222",
      requestId: "request-1",
      userMessage: "I advise the robotics club this year.",
      assistantMessage: "Noted.",
    })

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ content: candidate.content }),
    )
    expect(result.added).toBe(1)
  })
})
