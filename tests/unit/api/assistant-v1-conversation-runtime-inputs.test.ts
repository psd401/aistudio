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
    readonly headers: Map<string, string>

    constructor(
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> }
    ) {
      this.body = body
      this.status = init?.status ?? 200
      this.headers = new Map(Object.entries(init?.headers ?? {}))
    }

    static json(data: unknown, init?: { status?: number }) {
      return new TestNextResponse(JSON.stringify(data), init)
    }
  }

  return { NextRequest: TestNextRequest, NextResponse: TestNextResponse }
})

const mockPrepareAssistantExecutionInputs = jest.fn()
const mockExecuteAssistant = jest.fn()
const mockCreateConversation = jest.fn()
const mockCreateMessageWithStats = jest.fn()
const mockParseRequestBody = jest.fn()
const mockLogError = jest.fn()
const mockPreflightAssistantRepositoryAccess = jest.fn()
const mockBindNexusRequestAttachmentReferences = jest.fn()
const mockRollbackNewNexusAttachmentConversation = jest.fn()

jest.mock("@/lib/api", () => ({
  withApiAuth:
    (
      handler: (
        request: NextRequest,
        auth: {
          userId: number
          cognitoSub: string
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
          scopes: ["assistants:execute"],
        },
        "request-1"
      ),
  requireAssistantScope: jest.fn(() => null),
  createErrorResponse: (
    requestId: string,
    status: number,
    code: string,
    message: string
  ) => NextResponse.json({ requestId, error: { code, message } }, { status }),
  extractNumericParam: jest.fn(() => 5),
  verifyAssistantAccess: jest.fn(() => null),
  verifyAssistantResourceGrants: jest.fn(() => null),
  parseRequestBody: (...args: unknown[]) => mockParseRequestBody(...args),
  isErrorResponse: jest.fn(() => false),
}))

jest.mock("@/lib/api/assistant-service", () => ({
  getAssistantById: jest.fn(async () => ({ id: 5, name: "Assistant" })),
}))

jest.mock("@/actions/db/assistant-architect-actions", () => ({
  getAssistantArchitectByIdAction: jest.fn(async () => ({
    isSuccess: true,
    data: {
      id: 5,
      userId: 9,
      prompts: [{ id: 10, position: 0, modelId: 3 }],
    },
  })),
}))

jest.mock("@/lib/assistant-architect/repository-access-preflight", () => ({
  REPOSITORY_ACCESS_CHANGED_MESSAGE:
    "Repository access changed. Ask the assistant owner to update its sources.",
  preflightAssistantRepositoryAccess: (...args: unknown[]) =>
    mockPreflightAssistantRepositoryAccess(...args),
}))

jest.mock("@/lib/api/assistant-execution-service", () => ({
  executeAssistant: (...args: unknown[]) => mockExecuteAssistant(...args),
  validateExecutionInputs: jest.fn(() => null),
  isContentSafetyBlocked: jest.fn(() => false),
  isAssistantRuntimeRepositoryInputError: (error: unknown) =>
    error instanceof Error &&
    error.message === "Temporary repository input is unavailable",
  prepareAssistantExecutionInputs: (...args: unknown[]) =>
    mockPrepareAssistantExecutionInputs(...args),
}))

jest.mock("@/lib/db/drizzle/nexus-conversations", () => ({
  createConversation: (...args: unknown[]) => mockCreateConversation(...args),
}))

jest.mock("@/lib/db/drizzle/nexus-messages", () => ({
  createMessageWithStats: (...args: unknown[]) =>
    mockCreateMessageWithStats(...args),
}))

jest.mock("@/lib/nexus/request-attachment-binding", () => {
  class NexusAttachmentBindingRejectedError extends Error {}
  class NexusAttachmentBindingCleanupError extends Error {}

  return {
    bindNexusRequestAttachmentReferences: (...args: unknown[]) =>
      mockBindNexusRequestAttachmentReferences(...args),
    rollbackNewNexusAttachmentConversation: (...args: unknown[]) =>
      mockRollbackNewNexusAttachmentConversation(...args),
    NexusAttachmentBindingRejectedError,
    NexusAttachmentBindingCleanupError,
  }
})

jest.mock("@/lib/logger", () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => mockLogError(...args),
    debug: jest.fn(),
  })),
}))

import { POST } from "@/app/api/v1/assistants/[id]/conversations/route"

const bindingId = "123e4567-e89b-42d3-a456-426614174000"
const rawMarker =
  `[[repository-attachment:v1:${bindingId}:44:caller-forged-name.pdf]]`

describe("v1 assistant conversation runtime repository inputs", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockParseRequestBody.mockResolvedValue({
      data: {
        inputs: { file: rawMarker },
        title: "Runtime source",
      },
    })
    mockCreateConversation.mockResolvedValue({ id: "conversation-1" })
    mockCreateMessageWithStats.mockResolvedValue({ id: "message-1" })
    mockBindNexusRequestAttachmentReferences.mockResolvedValue(undefined)
    mockRollbackNewNexusAttachmentConversation.mockResolvedValue(undefined)
    mockExecuteAssistant.mockResolvedValue({
      streamResponse: new Response("stream", {
        headers: { "content-type": "text/event-stream" },
      }),
      executionId: 55,
    })
    mockPreflightAssistantRepositoryAccess.mockResolvedValue({
      isAllowed: true,
      repositoryIds: [],
    })
  })

  it("prepares before persistence and stores only authoritative marker-free inputs", async () => {
    const preparedInputs = {
      ownerId: 7,
      inputs: {
        file: "[Attached repository content: authoritative-name.pdf]",
      },
      runtimeRepositoryIds: [77],
      runtimeRepositoryQuery: "Attached source: authoritative-name.pdf",
      references: [
        { bindingId, itemId: 44, name: "authoritative-name.pdf" },
      ],
    }
    mockPrepareAssistantExecutionInputs.mockResolvedValue(preparedInputs)

    const response = await POST(
      new NextRequest("http://localhost/api/v1/assistants/5/conversations", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "5" }) }
    )

    expect({
      status: response.status,
      loggedErrors: mockLogError.mock.calls,
    }).toEqual({ status: 200, loggedErrors: [] })
    expect(mockPrepareAssistantExecutionInputs).toHaveBeenCalledWith(
      { file: rawMarker },
      7
    )
    expect(
      mockPrepareAssistantExecutionInputs.mock.invocationCallOrder[0]
    ).toBeLessThan(mockCreateConversation.mock.invocationCallOrder[0]!)
    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          assistantId: 5,
          runtimeRepositoryIds: [77],
        }),
      })
    )
    expect(mockBindNexusRequestAttachmentReferences).toHaveBeenCalledWith({
      ownerId: 7,
      conversationId: "conversation-1",
      references: preparedInputs.references,
      conversationCreated: true,
    })
    expect(
      mockBindNexusRequestAttachmentReferences.mock.invocationCallOrder[0]
    ).toBeLessThan(mockCreateMessageWithStats.mock.invocationCallOrder[0]!)
    expect(mockCreateMessageWithStats).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "file: [Attached repository content: authoritative-name.pdf]",
        metadata: {
          inputs: {
            file: "[Attached repository content: authoritative-name.pdf]",
          },
          source: "api",
        },
      })
    )
    expect(
      JSON.stringify(mockCreateMessageWithStats.mock.calls)
    ).not.toContain(bindingId)
    expect(
      JSON.stringify(mockCreateMessageWithStats.mock.calls)
    ).not.toContain("caller-forged-name.pdf")
    expect(mockExecuteAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: preparedInputs.inputs,
        userId: 7,
        cognitoSub: "executor-sub",
        preparedInputs,
      })
    )
    expect(mockRollbackNewNexusAttachmentConversation).not.toHaveBeenCalled()
  })

  it("compensates the bound empty conversation when first-message persistence fails", async () => {
    const preparedInputs = {
      ownerId: 7,
      inputs: {
        file: "[Attached repository content: authoritative-name.pdf]",
      },
      runtimeRepositoryIds: [77],
      runtimeRepositoryQuery: "Attached source: authoritative-name.pdf",
      references: [
        { bindingId, itemId: 44, name: "authoritative-name.pdf" },
      ],
    }
    mockPrepareAssistantExecutionInputs.mockResolvedValue(preparedInputs)
    mockCreateMessageWithStats.mockRejectedValue(
      new Error("first message write failed")
    )

    const response = await POST(
      new NextRequest("http://localhost/api/v1/assistants/5/conversations", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "5" }) }
    )

    expect(response.status).toBe(500)
    expect(mockBindNexusRequestAttachmentReferences).toHaveBeenCalled()
    expect(mockRollbackNewNexusAttachmentConversation).toHaveBeenCalledWith({
      ownerId: 7,
      conversationId: "conversation-1",
    })
    expect(
      mockCreateMessageWithStats.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mockRollbackNewNexusAttachmentConversation.mock.invocationCallOrder[0]!
    )
    expect(mockExecuteAssistant).not.toHaveBeenCalled()
  })

  it("rejects a foreign marker before conversation or message creation", async () => {
    mockPrepareAssistantExecutionInputs.mockRejectedValue(
      new Error("Temporary repository input is unavailable")
    )

    const response = await POST(
      new NextRequest("http://localhost/api/v1/assistants/5/conversations", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "5" }) }
    )

    expect(response.status).toBe(400)
    expect(mockCreateConversation).not.toHaveBeenCalled()
    expect(mockCreateMessageWithStats).not.toHaveBeenCalled()
    expect(mockExecuteAssistant).not.toHaveBeenCalled()
  })

  it("rejects revoked static repository access before creating a conversation", async () => {
    mockPreflightAssistantRepositoryAccess.mockResolvedValue({
      isAllowed: false,
      repositoryIds: [91],
    })

    const response = await POST(
      new NextRequest("http://localhost/api/v1/assistants/5/conversations", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "5" }) }
    )

    expect(response.status).toBe(403)
    expect(mockPrepareAssistantExecutionInputs).not.toHaveBeenCalled()
    expect(mockCreateConversation).not.toHaveBeenCalled()
    expect(mockCreateMessageWithStats).not.toHaveBeenCalled()
  })
})
