/** @jest-environment node */

import { NextRequest, NextResponse } from "next/server"

jest.mock("next/server", () => {
  class TestNextRequest {
    readonly url: string
    readonly headers: Map<string, string>

    constructor(input: string, init?: { headers?: Record<string, string> }) {
      this.url = input
      this.headers = new Map(
        Object.entries(init?.headers ?? {}).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ])
      )
    }
  }

  class TestNextResponse {
    readonly body: unknown
    readonly status: number
    readonly headers: Headers

    constructor(
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> }
    ) {
      this.body = body
      this.status = init?.status ?? 200
      this.headers = new Headers(init?.headers)
    }

    static json(data: unknown, init?: { status?: number }) {
      return new TestNextResponse(JSON.stringify(data), init)
    }
  }

  return { NextRequest: TestNextRequest, NextResponse: TestNextResponse }
})

const mockGetConversationById = jest.fn()
const mockGetMessagesByConversation = jest.fn()
const mockCreateMessageWithStats = jest.fn()
const mockParseRequestBody = jest.fn()
const mockGetAssistantArchitectByIdAction = jest.fn()
const mockVerifyAssistantResourceGrants = jest.fn()
const mockPreflightAssistantRepositoryAccess = jest.fn()
const mockGetAIModelById = jest.fn()
const mockRetrieveKnowledgeForPrompt = jest.fn()
const mockFormatKnowledgeContext = jest.fn()
const mockCreateRepositoryTools = jest.fn()
const mockStream = jest.fn()
const mockCreateCoordinatedAssistantExecution = jest.fn()
const mockSettleCoordinatedAssistantExecution = jest.fn()
const mockLoadValidatedConversationRepositoryContext = jest.fn()

jest.mock("@/lib/api", () => ({
  withApiAuth:
    (
      handler: (
        request: NextRequest,
        auth: {
          userId: number
          cognitoSub: string
          authType: "session" | "api_key" | "jwt"
          scopes: string[]
        },
        requestId: string
      ) => Promise<NextResponse>
    ) =>
    (request: NextRequest) =>
      handler(
        request,
        {
          userId: 7,
          cognitoSub: "executor-sub",
          authType: "api_key",
          scopes: ["assistants:execute", "assistants:list"],
        },
        "request-1"
      ),
  requireAssistantScope: jest.fn(() => null),
  requireScope: jest.fn(() => null),
  createApiResponse: (data: unknown, _requestId: string, status = 200) =>
    NextResponse.json(data, { status }),
  createErrorResponse: (
    requestId: string,
    status: number,
    code: string,
    message: string
  ) => NextResponse.json({ requestId, error: { code, message } }, { status }),
  extractNumericParam: jest.fn(() => 5),
  extractStringParam: jest.fn(() => "conversation-1"),
  verifyAssistantAccess: jest.fn(() => null),
  verifyAssistantResourceGrants: (...args: unknown[]) =>
    mockVerifyAssistantResourceGrants(...args),
  parseRequestBody: (...args: unknown[]) => mockParseRequestBody(...args),
  isErrorResponse: jest.fn(() => false),
}))

jest.mock("@/actions/db/assistant-architect-actions", () => ({
  getAssistantArchitectByIdAction: (...args: unknown[]) =>
    mockGetAssistantArchitectByIdAction(...args),
}))

jest.mock("@/lib/db/drizzle/nexus-conversations", () => ({
  getConversationById: (...args: unknown[]) =>
    mockGetConversationById(...args),
}))

jest.mock("@/lib/db/drizzle/nexus-messages", () => ({
  getMessagesByConversation: (...args: unknown[]) =>
    mockGetMessagesByConversation(...args),
  createMessageWithStats: (...args: unknown[]) =>
    mockCreateMessageWithStats(...args),
}))

jest.mock("@/lib/db/drizzle", () => ({
  getAIModelById: (...args: unknown[]) => mockGetAIModelById(...args),
}))

jest.mock("@/lib/assistant-architect/repository-access-preflight", () => ({
  REPOSITORY_ACCESS_CHANGED_MESSAGE:
    "Repository access changed. Ask the assistant owner to update its sources.",
  preflightAssistantRepositoryAccess: (...args: unknown[]) =>
    mockPreflightAssistantRepositoryAccess(...args),
}))

jest.mock("@/lib/nexus/conversation-repository-service", () => {
  class ConversationRepositoryBindingError extends Error {
    code = "REPOSITORY_BINDING_INACCESSIBLE"
  }
  return {
    ConversationRepositoryBindingError,
    loadValidatedConversationRepositoryContext: (...args: unknown[]) =>
      mockLoadValidatedConversationRepositoryContext(...args),
  }
})

jest.mock("@/lib/repositories/readiness-service", () => {
  class RepositoryReadinessError extends Error {
    code = "REPOSITORY_NOT_READY"
  }
  return { RepositoryReadinessError }
})

jest.mock("@/lib/assistant-architect/knowledge-retrieval", () => ({
  retrieveKnowledgeForPrompt: (...args: unknown[]) =>
    mockRetrieveKnowledgeForPrompt(...args),
  formatKnowledgeContext: (...args: unknown[]) =>
    mockFormatKnowledgeContext(...args),
}))

jest.mock("@/lib/tools/repository-tools", () => ({
  createRepositoryTools: (...args: unknown[]) =>
    mockCreateRepositoryTools(...args),
}))

jest.mock("@/lib/streaming/unified-streaming-service", () => ({
  unifiedStreamingService: {
    stream: (...args: unknown[]) => mockStream(...args),
  },
}))

jest.mock("@/lib/assistant-architect/execution-coordinator", () => ({
  createCoordinatedAssistantExecution: (...args: unknown[]) =>
    mockCreateCoordinatedAssistantExecution(...args),
  settleCoordinatedAssistantExecution: (...args: unknown[]) =>
    mockSettleCoordinatedAssistantExecution(...args),
  remainingAssistantExecutionTimeoutMs: jest.fn(() => 900000),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}))

import { POST } from "@/app/api/v1/assistants/[id]/conversations/[cid]/messages/route"
import { GET } from "@/app/api/v1/assistants/[id]/conversations/[cid]/route"

const conversation = {
  id: "conversation-1",
  userId: 7,
  title: "Assistant Conversation",
  provider: "assistant-architect",
  metadata: {
    source: "api",
    assistantId: 5,
    runtimeRepositoryIds: [77],
  },
  messageCount: 1,
  createdAt: new Date("2026-07-23T12:00:00.000Z"),
  updatedAt: new Date("2026-07-23T12:00:00.000Z"),
}

const prompts = [
  {
    id: 10,
    position: 0,
    modelId: 2,
    repositoryIds: [11],
    systemContext: "First prompt",
  },
  {
    id: 11,
    position: 1,
    modelId: 3,
    repositoryIds: [12],
    systemContext: "Follow-up system prompt",
  },
]

function createPostRequest() {
  return new NextRequest(
    "http://localhost/api/v1/assistants/5/conversations/conversation-1/messages",
    { method: "POST" }
  )
}

function setupFollowUpMocks() {
  jest.clearAllMocks()
  mockGetConversationById.mockResolvedValue(conversation)
  mockGetAssistantArchitectByIdAction.mockResolvedValue({
    isSuccess: true,
    data: {
      id: 5,
      userId: 9,
      prompts,
    },
  })
  mockVerifyAssistantResourceGrants.mockResolvedValue(null)
  mockPreflightAssistantRepositoryAccess.mockResolvedValue({
    isAllowed: true,
    repositoryIds: [11, 12, 77],
  })
  mockLoadValidatedConversationRepositoryContext.mockResolvedValue({
    bindings: [
      {
        repositoryId: 77,
        source: "assistant",
        sourceId: "5",
      },
    ],
    repositoryIds: [77],
    readiness: [],
  })
  mockGetAIModelById.mockResolvedValue({
    id: 3,
    modelId: "model-3",
    provider: "openai",
  })
  mockParseRequestBody.mockResolvedValue({
    data: { message: "What changed?" },
  })
  mockGetMessagesByConversation.mockResolvedValue([
    {
      id: "existing-message",
      role: "assistant",
      content: "Previous answer",
      parts: [{ type: "text", text: "Previous answer" }],
    },
  ])
  mockRetrieveKnowledgeForPrompt.mockResolvedValue([
    { content: "Repository evidence" },
  ])
  mockFormatKnowledgeContext.mockReturnValue(
    "[bounded repository context]"
  )
  mockCreateRepositoryTools.mockReturnValue({
    search_repository: { description: "Search repositories" },
  })
  mockCreateMessageWithStats.mockResolvedValue({ id: "new-message" })
  mockCreateCoordinatedAssistantExecution.mockResolvedValue({
    created: true,
    executionId: 55,
    startedAt: new Date("2026-07-28T12:00:00.000Z"),
    deadlineAt: new Date("2026-07-28T12:15:00.000Z"),
  })
  mockSettleCoordinatedAssistantExecution.mockResolvedValue(undefined)
  mockStream.mockResolvedValue({
    result: {
      toUIMessageStreamResponse: () =>
        new Response("stream", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    },
  })
}

describe("v1 assistant conversation follow-up repository boundaries", () => {
  beforeEach(setupFollowUpMocks)

  it("rejects an assistant/path metadata mismatch before loading or writing", async () => {
    mockGetConversationById.mockResolvedValue({
      ...conversation,
      metadata: { ...conversation.metadata, assistantId: 6 },
    })

    const response = await POST(createPostRequest(), {
      params: Promise.resolve({ id: "5", cid: "conversation-1" }),
    })

    expect(response.status).toBe(404)
    expect(mockGetAssistantArchitectByIdAction).not.toHaveBeenCalled()
    expect(mockPreflightAssistantRepositoryAccess).not.toHaveBeenCalled()
    expect(mockParseRequestBody).not.toHaveBeenCalled()
    expect(mockCreateMessageWithStats).not.toHaveBeenCalled()
    expect(mockStream).not.toHaveBeenCalled()
  })
})

describe("v1 assistant conversation follow-up coordination", () => {
  beforeEach(setupFollowUpMocks)

  it("returns a clean 403 for repository ACL drift before message writes", async () => {
    mockPreflightAssistantRepositoryAccess.mockResolvedValue({
      isAllowed: false,
      repositoryIds: [11, 12, 77],
    })

    const response = await POST(createPostRequest(), {
      params: Promise.resolve({ id: "5", cid: "conversation-1" }),
    })

    expect(response.status).toBe(403)
    expect(mockPreflightAssistantRepositoryAccess).toHaveBeenCalledWith(
      [...prompts, { repositoryIds: [77] }],
      "executor-sub"
    )
    expect(mockParseRequestBody).toHaveBeenCalled()
    expect(mockCreateCoordinatedAssistantExecution).toHaveBeenCalled()
    expect(mockSettleCoordinatedAssistantExecution).toHaveBeenCalledWith({
      executionId: 55,
      status: "failed",
      errorMessage: "Assistant follow-up setup rejected",
    })
    expect(mockGetMessagesByConversation).not.toHaveBeenCalled()
    expect(mockRetrieveKnowledgeForPrompt).not.toHaveBeenCalled()
    expect(mockCreateMessageWithStats).not.toHaveBeenCalled()
    expect(mockStream).not.toHaveBeenCalled()
  })

  it("preserves a coordinator 404 when approval resets before the follow-up lock", async () => {
    mockCreateCoordinatedAssistantExecution.mockRejectedValue({
      statusCode: 404,
      userMessage: "Assistant not found: 5",
    })

    const response = await POST(createPostRequest(), {
      params: Promise.resolve({ id: "5", cid: "conversation-1" }),
    })

    expect(response.status).toBe(404)
    expect(mockGetAssistantArchitectByIdAction).not.toHaveBeenCalled()
    expect(mockCreateMessageWithStats).not.toHaveBeenCalled()
    expect(mockStream).not.toHaveBeenCalled()
  })

  it("uses static and runtime repositories for bounded context and tools while persisting raw text", async () => {
    const response = await POST(createPostRequest(), {
      params: Promise.resolve({ id: "5", cid: "conversation-1" }),
    })

    expect(response.status).toBe(200)
    expect(mockPreflightAssistantRepositoryAccess).toHaveBeenCalledWith(
      [...prompts, { repositoryIds: [77] }],
      "executor-sub"
    )
    expect(mockRetrieveKnowledgeForPrompt).toHaveBeenCalledWith(
      "What changed?",
      [11, 12, 77],
      "executor-sub",
      {
        maxChunks: 10,
        maxTokens: 4000,
        similarityThreshold: 0.7,
        searchType: "hybrid",
        vectorWeight: 0.8,
      },
      "request-1"
    )
    expect(mockCreateRepositoryTools).toHaveBeenCalledWith({
      repositoryIds: [11, 12, 77],
      userCognitoSub: "executor-sub",
    })
    expect(mockCreateMessageWithStats).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      role: "user",
      content: "What changed?",
      parts: [{ type: "text", text: "What changed?" }],
      metadata: { source: "api" },
    })

    const streamRequest = mockStream.mock.calls[0]?.[0] as {
      messages: Array<{
        role: string
        parts: Array<{ type: string; text?: string }>
      }>
      tools?: Record<string, unknown>
      maxSteps?: number
      executionId?: number
      timeout?: number
      callbacks?: {
        onFinish?: (data: {
          text: string
          usage: {
            promptTokens: number
            completionTokens: number
            totalTokens: number
          }
          finishReason: string
        }) => void | Promise<void>
      }
    }
    expect(streamRequest.messages.at(-1)).toEqual({
      id: expect.stringMatching(/^user-/),
      role: "user",
      parts: [
        {
          type: "text",
          text: "What changed?\n\n[bounded repository context]",
        },
      ],
    })
    expect(streamRequest.tools).toEqual({
      search_repository: { description: "Search repositories" },
    })
    expect(streamRequest.maxSteps).toBe(5)
    expect(streamRequest.executionId).toBe(55)
    expect(streamRequest.timeout).toBe(900000)
    expect(mockCreateCoordinatedAssistantExecution).toHaveBeenCalledWith({
      assistantId: 5,
      userId: 7,
      inputs: { message: "What changed?" },
      requireApproved: true,
      modelAccessMode: "final_prompt",
    })
    expect(
      mockCreateCoordinatedAssistantExecution.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mockGetAssistantArchitectByIdAction.mock.invocationCallOrder[0]!
    )
    await streamRequest.callbacks?.onFinish?.({
      text: "Current answer",
      usage: {
        promptTokens: 3,
        completionTokens: 2,
        totalTokens: 5,
      },
      finishReason: "stop",
    })
    expect(mockSettleCoordinatedAssistantExecution).toHaveBeenCalledWith({
      executionId: 55,
      status: "completed",
    })
    expect(JSON.stringify(mockCreateMessageWithStats.mock.calls)).not.toContain(
      "[bounded repository context]"
    )
  })
})

describe("v1 assistant conversation history path binding", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetConversationById.mockResolvedValue({
      ...conversation,
      metadata: { ...conversation.metadata, assistantId: 6 },
    })
    mockGetMessagesByConversation.mockResolvedValue([])
  })

  it("rejects a conversation bound to a different assistant before loading messages", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/v1/assistants/5/conversations/conversation-1"
      ),
      { params: Promise.resolve({ id: "5", cid: "conversation-1" }) }
    )

    expect(response.status).toBe(404)
    expect(mockGetMessagesByConversation).not.toHaveBeenCalled()
  })
})
