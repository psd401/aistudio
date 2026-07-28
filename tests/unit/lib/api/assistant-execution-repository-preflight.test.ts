const mockRepositoryAccessPreflight = jest.fn()
const mockGetAssistantArchitectByIdAction = jest.fn()
const mockExecuteQuery = jest.fn()
const mockCreateCoordinatedAssistantExecution = jest.fn()
const mockUnifiedStream = jest.fn()
const mockResolveRuntimeRepositoryInputs = jest.fn()
const mockRetrieveKnowledgeForPrompt = jest.fn()
const mockRetrieveAtriumKnowledgeForPrompt = jest.fn()
const mockCreateRepositoryTools = jest.fn()
const mockStoreExecutionEvent = jest.fn()
const mockRouteAssistantArchitectModel = jest.fn()

jest.mock("@/lib/assistant-architect/runtime-repository-inputs", () => ({
  resolveAssistantRuntimeRepositoryInputs: (...args: unknown[]) =>
    mockResolveRuntimeRepositoryInputs(...args),
}))

jest.mock("@/lib/assistant-architect/repository-access-preflight", () => ({
  REPOSITORY_ACCESS_CHANGED_MESSAGE:
    "Repository access changed. Request access to every repository used by this assistant before trying again.",
  preflightAssistantRepositoryAccess: (...args: unknown[]) =>
    mockRepositoryAccessPreflight(...args),
}))

jest.mock("@/actions/db/assistant-architect-actions", () => ({
  getAssistantArchitectByIdAction: (...args: unknown[]) =>
    mockGetAssistantArchitectByIdAction(...args),
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}))

jest.mock("@/lib/db/drizzle", () => ({
  getUserById: jest.fn(),
}))

jest.mock("@/lib/assistant-architect/execution-coordinator", () => ({
  createCoordinatedAssistantExecution: (...args: unknown[]) =>
    mockCreateCoordinatedAssistantExecution(...args),
  remainingAssistantExecutionTimeoutMs: jest.fn(() => 60_000),
}))

jest.mock("@/lib/streaming/unified-streaming-service", () => ({
  unifiedStreamingService: {
    stream: (...args: unknown[]) => mockUnifiedStream(...args),
  },
}))

jest.mock("@/lib/assistant-architect/knowledge-retrieval", () => ({
  retrieveKnowledgeForPrompt: (...args: unknown[]) =>
    mockRetrieveKnowledgeForPrompt(...args),
  formatKnowledgeContext: jest.fn(() => ""),
  retrieveAtriumKnowledgeForPrompt: (...args: unknown[]) =>
    mockRetrieveAtriumKnowledgeForPrompt(...args),
  formatAtriumKnowledgeContext: jest.fn(() => ""),
}))

jest.mock("@/lib/content/requester-from-auth", () => ({
  requesterForUserId: jest.fn(),
}))

jest.mock("@/lib/tools/repository-tools", () => ({
  createRepositoryTools: (...args: unknown[]) =>
    mockCreateRepositoryTools(...args),
}))

jest.mock("@/lib/assistant-architect/event-storage", () => ({
  storeExecutionEvent: (...args: unknown[]) =>
    mockStoreExecutionEvent(...args),
}))

jest.mock("@/lib/assistant-architect/model-router", () => ({
  routeAssistantArchitectModel: (...args: unknown[]) =>
    mockRouteAssistantArchitectModel(...args),
}))

jest.mock("@/lib/error-utils", () => ({
  ErrorFactories: new Proxy({}, {
    get: (_target, property) => (...args: unknown[]) => {
      const error = new Error(`mock-error:${String(property)}`)
      if (property === "authzToolAccessDenied") {
        Object.assign(error, args[1])
      }
      return error
    },
  }),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((value: unknown) => value),
}))

import {
  executeAssistant,
  executeAssistantForJobCompletion,
} from "@/lib/api/assistant-execution-service"

function defineAssistantExecutionServiceRepositoryPreflightSuite1Part1() {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveRuntimeRepositoryInputs.mockResolvedValue({
      repositoryIds: [],
      queryContext: "",
      references: [],
      modelInputs: {},
    })
    mockRepositoryAccessPreflight.mockResolvedValue({
      isAllowed: true,
      repositoryIds: [42],
    })
    mockCreateCoordinatedAssistantExecution.mockResolvedValue({
      created: true,
      executionId: 123,
      startedAt: new Date("2026-07-28T00:00:00.000Z"),
      deadlineAt: new Date("2026-07-28T00:15:00.000Z"),
    })
    mockExecuteQuery.mockResolvedValue([{ id: 123 }])
    mockRetrieveKnowledgeForPrompt.mockResolvedValue([])
    mockRetrieveAtriumKnowledgeForPrompt.mockResolvedValue([])
    mockCreateRepositoryTools.mockReturnValue({})
    mockStoreExecutionEvent.mockResolvedValue(undefined)
    mockRouteAssistantArchitectModel.mockResolvedValue({
      modelId: "model-3",
      provider: "openai",
      metadata: { mode: "legacy" },
    })
    mockGetAssistantArchitectByIdAction.mockResolvedValue({
      isSuccess: true,
      data: {
        id: 5,
        name: "Shared assistant",
        userId: 99,
        mode: "prompt-chain",
        modelRoutingMode: "legacy",
        modelRoutingFamily: null,
        prompts: [{
          id: 10,
          name: "Retrieve",
          content: "Use the repository: ${file}",
          systemContext: null,
          modelId: 3,
          position: 0,
          parallelGroup: null,
          inputMapping: null,
          repositoryIds: [42],
          enabledTools: null,
          timeoutSeconds: null,
        }, {
          id: 11,
          name: "Verify",
          content: "Verify against the source: ${file}",
          systemContext: null,
          modelId: 3,
          position: 1,
          parallelGroup: null,
          inputMapping: null,
          repositoryIds: [43],
          enabledTools: null,
          timeoutSeconds: null,
        }],
      },
    })
  })

  it("marks a coordinated execution record failed before any model call when repository access is revoked", async () => {
    mockRepositoryAccessPreflight.mockResolvedValue({
      isAllowed: false,
      repositoryIds: [42],
    })

    const execution = executeAssistant({
      assistantId: 5,
      inputs: {},
      userId: 7,
      cognitoSub: "executor-sub",
      requestId: "request-1",
    })

    await expect(execution).rejects.toMatchObject({
      userMessage: expect.stringMatching(/Repository access changed/),
    })
    expect(mockRepositoryAccessPreflight).toHaveBeenCalledWith(
      expect.any(Array),
      "executor-sub"
    )
    expect(mockCreateCoordinatedAssistantExecution).toHaveBeenCalledTimes(1)
    expect(
      mockCreateCoordinatedAssistantExecution.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mockGetAssistantArchitectByIdAction.mock.invocationCallOrder[0]
    )
    expect(mockExecuteQuery).toHaveBeenCalled()
    expect(mockUnifiedStream).not.toHaveBeenCalled()
  })

  it("returns a validation error when the coordinator rejects graph cardinality", async () => {
    mockCreateCoordinatedAssistantExecution.mockResolvedValueOnce({
      created: false,
      reason: "invalid_graph",
      promptCount: 21,
      maxPromptCount: 20,
    })

    await expect(executeAssistant({
      assistantId: 5,
      inputs: {},
      userId: 7,
      cognitoSub: "executor-sub",
      requestId: "request-invalid-graph",
    })).rejects.toThrow("mock-error:validationFailed")
    expect(mockGetAssistantArchitectByIdAction).not.toHaveBeenCalled()
    expect(mockUnifiedStream).not.toHaveBeenCalled()
  })

  }

function defineAssistantExecutionServiceRepositoryPreflightSuite1Part2() {it.each([
    ["streaming", executeAssistant],
    ["async job", executeAssistantForJobCompletion],
  ] as const)(
    "unions canonical runtime repositories into retrieval and tools for %s execution",
    async (_mode, execute) => {
      const bindingId = "123e4567-e89b-42d3-a456-426614174000"
      const forgedMarker =
        `[[repository-attachment:v1:${bindingId}:44:forged-name.pdf]]`
      mockResolveRuntimeRepositoryInputs.mockResolvedValue({
        repositoryIds: [77],
        queryContext: "Attached source: authoritative-name.pdf",
        references: [
          { bindingId, itemId: 44, name: "authoritative-name.pdf" },
        ],
        modelInputs: {
          file: "[Attached repository content: authoritative-name.pdf]",
        },
      })
      mockCreateRepositoryTools.mockReturnValue({ vectorSearch: {} })
      mockUnifiedStream.mockImplementation(async (request: unknown) => {
        const streamRequest = request as {
          callbacks: {
            onFinish: (result: {
              text: string
              usage: {
                promptTokens: number
                completionTokens: number
                totalTokens: number
              }
            }) => Promise<void>
          }
        }
        queueMicrotask(() => {
          void streamRequest.callbacks.onFinish({
            text: "done",
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          })
        })
        return {
          result: {
            toUIMessageStreamResponse: () => new Response("stream"),
          },
        }
      })

      await execute({
        assistantId: 5,
        inputs: { file: forgedMarker },
        userId: 7,
        cognitoSub: "executor-sub",
        requestId: `request-${_mode}`,
      })

      expect(mockResolveRuntimeRepositoryInputs).toHaveBeenCalledWith(
        { file: forgedMarker },
        7
      )
      expect(mockRepositoryAccessPreflight).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ repositoryIds: [77] }),
        ]),
        "executor-sub"
      )
      expect(mockRetrieveKnowledgeForPrompt).toHaveBeenCalledWith(
        expect.stringContaining("Attached source: authoritative-name.pdf"),
        [42, 77],
        "executor-sub",
        expect.any(Object),
        expect.any(String)
      )
      expect(mockRetrieveKnowledgeForPrompt).toHaveBeenCalledWith(
        expect.stringContaining("Attached source: authoritative-name.pdf"),
        [43, 77],
        "executor-sub",
        expect.any(Object),
        expect.any(String)
      )
      expect(mockCreateRepositoryTools).toHaveBeenNthCalledWith(1, {
          repositoryIds: [42, 77],
          userCognitoSub: "executor-sub",
          assistantOwnerSub: undefined,
        })
      expect(mockCreateRepositoryTools).toHaveBeenNthCalledWith(2, {
          repositoryIds: [43, 77],
          userCognitoSub: "executor-sub",
          assistantOwnerSub: undefined,
        })

      const providerRequest = mockUnifiedStream.mock.calls[0]?.[0] as {
        messages: unknown
      }
      expect(JSON.stringify(providerRequest.messages)).toContain(
        "[Attached repository content: authoritative-name.pdf]"
      )
      expect(JSON.stringify(providerRequest.messages)).not.toContain(bindingId)
      expect(JSON.stringify(providerRequest.messages)).not.toContain(
        "forged-name.pdf"
      )
      expect(mockUnifiedStream).toHaveBeenCalledTimes(2)
    }
  )

  }

function defineAssistantExecutionServiceRepositoryPreflightSuite1Part3() {it("rejects a foreign runtime reference before execution persistence", async () => {
    mockResolveRuntimeRepositoryInputs.mockRejectedValue(
      new Error("Temporary repository input is unavailable")
    )

    await expect(
      executeAssistant({
        assistantId: 5,
        inputs: {
          file:
            "[[repository-attachment:v1:123e4567-e89b-42d3-a456-426614174000:44:forged.pdf]]",
        },
        userId: 7,
        cognitoSub: "executor-sub",
        requestId: "request-invalid-runtime",
      })
    ).rejects.toThrow("unavailable")

    expect(mockExecuteQuery).not.toHaveBeenCalled()
    expect(mockStoreExecutionEvent).not.toHaveBeenCalled()
    expect(mockUnifiedStream).not.toHaveBeenCalled()
  })
}

function parallelFinalPromptAssistant() {
  return {
    isSuccess: true,
    data: {
      id: 5,
      name: "Parallel assistant",
      userId: 99,
      mode: "prompt-chain",
      modelRoutingMode: "legacy",
      modelRoutingFamily: null,
      prompts: [10, 11].map((id) => ({
        id,
        name: `Parallel ${id}`,
        content: `Prompt ${id}`,
        systemContext: null,
        modelId: 3,
        position: 0,
        parallelGroup: id,
        inputMapping: null,
        repositoryIds: [],
        enabledTools: null,
        timeoutSeconds: null,
      })),
    },
  }
}

interface FinishCallbacks {
  onFinish: (result: {
    text: string
    usage: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
    }
  }) => Promise<void>
}

const finishResult = {
  text: "done",
  usage: {
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
  },
}

function completedExecutionCallCount(): number {
  return mockExecuteQuery.mock.calls.filter(
    (call) => call[1] === "updateToolExecutionCompleted"
  ).length
}

function defineAssistantExecutionCompletionBarrierSuite() {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveRuntimeRepositoryInputs.mockResolvedValue({
      repositoryIds: [],
      queryContext: "",
      references: [],
      modelInputs: {},
    })
    mockRepositoryAccessPreflight.mockResolvedValue({
      isAllowed: true,
      repositoryIds: [],
    })
    mockCreateCoordinatedAssistantExecution.mockResolvedValue({
      created: true,
      executionId: 123,
      startedAt: new Date("2026-07-28T00:00:00.000Z"),
      deadlineAt: new Date("2026-07-28T00:15:00.000Z"),
    })
    mockExecuteQuery.mockResolvedValue([{ id: 123 }])
    mockRetrieveKnowledgeForPrompt.mockResolvedValue([])
    mockRetrieveAtriumKnowledgeForPrompt.mockResolvedValue([])
    mockCreateRepositoryTools.mockReturnValue({})
    mockStoreExecutionEvent.mockResolvedValue(undefined)
    mockRouteAssistantArchitectModel.mockResolvedValue({
      modelId: "model-3",
      provider: "openai",
      metadata: { mode: "legacy" },
    })
    mockGetAssistantArchitectByIdAction.mockResolvedValue(
      parallelFinalPromptAssistant()
    )
    mockUnifiedStream.mockImplementation(async () => ({
      result: {
        toUIMessageStreamResponse: () => new Response("stream"),
      },
    }))
  })

  it("keeps a streaming execution active until every final sibling persists", async () => {
    const callbacks: FinishCallbacks[] = []
    let callbacksReady!: () => void
    const ready = new Promise<void>((resolve) => {
      callbacksReady = resolve
    })
    mockUnifiedStream.mockImplementation(async (request: unknown) => {
      callbacks.push((request as { callbacks: FinishCallbacks }).callbacks)
      if (callbacks.length === 2) callbacksReady()
      return {
        result: {
          toUIMessageStreamResponse: () => new Response("stream"),
        },
      }
    })

    const execution = executeAssistant({
      assistantId: 5,
      inputs: {},
      userId: 7,
      cognitoSub: "executor-sub",
      requestId: "request-parallel-stream",
    })
    await ready
    await callbacks[0].onFinish(finishResult)
    expect(completedExecutionCallCount()).toBe(0)

    await callbacks[1].onFinish(finishResult)
    await execution
    expect(completedExecutionCallCount()).toBe(1)
    expect(mockStoreExecutionEvent).toHaveBeenCalledWith(
      123,
      "execution-complete",
      expect.objectContaining({ totalTokens: 4 })
    )
  })

  it("keeps a job execution active until every final sibling persists", async () => {
    const callbacks: FinishCallbacks[] = []
    let firstReady!: () => void
    let secondReady!: () => void
    const first = new Promise<void>((resolve) => {
      firstReady = resolve
    })
    const second = new Promise<void>((resolve) => {
      secondReady = resolve
    })
    mockUnifiedStream.mockImplementation(async (request: unknown) => {
      callbacks.push((request as { callbacks: FinishCallbacks }).callbacks)
      if (callbacks.length === 1) firstReady()
      if (callbacks.length === 2) secondReady()
      return {
        result: {
          toUIMessageStreamResponse: () => new Response("stream"),
        },
      }
    })

    const execution = executeAssistantForJobCompletion({
      assistantId: 5,
      inputs: {},
      userId: 7,
      cognitoSub: "executor-sub",
      requestId: "request-parallel-job",
    })
    await first
    await callbacks[0].onFinish(finishResult)
    await second
    expect(completedExecutionCallCount()).toBe(0)

    await callbacks[1].onFinish(finishResult)
    await execution
    expect(completedExecutionCallCount()).toBe(1)
    expect(mockStoreExecutionEvent).toHaveBeenCalledWith(
      123,
      "execution-complete",
      expect.objectContaining({ totalTokens: 4 })
    )
  })
}

const defineAssistantExecutionServiceRepositoryPreflightSuite1 = () => {
  defineAssistantExecutionServiceRepositoryPreflightSuite1Part1()
  defineAssistantExecutionServiceRepositoryPreflightSuite1Part2()
  defineAssistantExecutionServiceRepositoryPreflightSuite1Part3()
};

describe("assistant execution service repository preflight", defineAssistantExecutionServiceRepositoryPreflightSuite1)
describe(
  "assistant execution completion barrier",
  defineAssistantExecutionCompletionBarrierSuite
)
