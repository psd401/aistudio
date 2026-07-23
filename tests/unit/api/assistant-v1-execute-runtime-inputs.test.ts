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
const mockExecuteAssistantForJobCompletion = jest.fn()
const mockCreateJob = jest.fn()
const mockCompleteJob = jest.fn()
const mockFailJob = jest.fn()
const mockParseRequestBody = jest.fn()
const mockPreflightAssistantRepositoryAccess = jest.fn()

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
  requireScope: jest.fn(() => null),
  createApiResponse: (
    body: unknown,
    _requestId: string,
    status: number
  ) => NextResponse.json(body, { status }),
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
  executeAssistant: jest.fn(),
  executeAssistantForJobCompletion: (...args: unknown[]) =>
    mockExecuteAssistantForJobCompletion(...args),
  validateExecutionInputs: jest.fn(() => null),
  isContentSafetyBlocked: jest.fn(() => false),
  isAssistantRuntimeRepositoryInputError: (error: unknown) =>
    error instanceof Error &&
    error.message === "Temporary repository input is unavailable",
  prepareAssistantExecutionInputs: (...args: unknown[]) =>
    mockPrepareAssistantExecutionInputs(...args),
}))

jest.mock("@/lib/streaming/job-management-service", () => ({
  jobManagementService: {
    createJob: (...args: unknown[]) => mockCreateJob(...args),
    completeJob: (...args: unknown[]) => mockCompleteJob(...args),
    failJob: (...args: unknown[]) => mockFailJob(...args),
  },
}))

jest.mock("@/lib/tools/catalog/catalog", () => ({
  toolCatalogInstance: {
    get: jest.fn(async () => ({
      isActive: true,
      requiredScopes: ["assistants:execute"],
      surfaceScopes: { rest: ["assistants:execute"] },
    })),
  },
}))

jest.mock("@/lib/logger", () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  startTimer: jest.fn(() => jest.fn()),
}))

import { POST } from "@/app/api/v1/assistants/[id]/execute/route"

const bindingId = "123e4567-e89b-42d3-a456-426614174000"
const rawMarker =
  `[[repository-attachment:v1:${bindingId}:44:caller-forged-name.pdf]]`

describe("v1 async assistant runtime repository inputs", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockParseRequestBody.mockResolvedValue({
      data: { inputs: { file: rawMarker } },
    })
    mockCreateJob.mockResolvedValue("job-1")
    mockCompleteJob.mockResolvedValue(undefined)
    mockFailJob.mockResolvedValue(undefined)
    mockExecuteAssistantForJobCompletion.mockResolvedValue({
      executionId: 55,
      text: "done",
    })
    mockPreflightAssistantRepositoryAccess.mockResolvedValue({
      isAllowed: true,
      repositoryIds: [],
    })
  })

  it("prepares before job creation and reuses the exact preparation in the job", async () => {
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
      new NextRequest("http://localhost/api/v1/assistants/5/execute", {
        method: "POST",
        headers: { accept: "application/json" },
      }),
      { params: Promise.resolve({ id: "5" }) }
    )
    await Promise.resolve()

    expect(response.status).toBe(202)
    expect(
      mockPrepareAssistantExecutionInputs.mock.invocationCallOrder[0]
    ).toBeLessThan(mockCreateJob.mock.invocationCallOrder[0]!)
    expect(mockExecuteAssistantForJobCompletion).toHaveBeenCalledWith({
      assistantId: 5,
      inputs: preparedInputs.inputs,
      userId: 7,
      cognitoSub: "executor-sub",
      requestId: "request-1",
      preparedInputs,
    })
    expect(JSON.stringify(mockCreateJob.mock.calls)).not.toContain(bindingId)
    expect(JSON.stringify(mockCreateJob.mock.calls)).not.toContain(
      "caller-forged-name.pdf"
    )
  })

  it("rejects a foreign marker before creating a polling job", async () => {
    mockPrepareAssistantExecutionInputs.mockRejectedValue(
      new Error("Temporary repository input is unavailable")
    )

    const response = await POST(
      new NextRequest("http://localhost/api/v1/assistants/5/execute", {
        method: "POST",
        headers: { accept: "application/json" },
      }),
      { params: Promise.resolve({ id: "5" }) }
    )

    expect(response.status).toBe(400)
    expect(mockCreateJob).not.toHaveBeenCalled()
    expect(mockExecuteAssistantForJobCompletion).not.toHaveBeenCalled()
  })

  it("rejects revoked static repository access before creating a polling job", async () => {
    mockPreflightAssistantRepositoryAccess.mockResolvedValue({
      isAllowed: false,
      repositoryIds: [91],
    })

    const response = await POST(
      new NextRequest("http://localhost/api/v1/assistants/5/execute", {
        method: "POST",
        headers: { accept: "application/json" },
      }),
      { params: Promise.resolve({ id: "5" }) }
    )

    expect(response.status).toBe(403)
    expect(mockPrepareAssistantExecutionInputs).not.toHaveBeenCalled()
    expect(mockCreateJob).not.toHaveBeenCalled()
  })
})
