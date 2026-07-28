jest.mock("@/lib/client-logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ChatModelRunResult,
} from "@assistant-ui/react"
import { createNexusPollingAdapter } from "@/lib/nexus/nexus-polling-adapter"

const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()

function runOptions(
  abortSignal = new AbortController().signal
): ChatModelRunOptions {
  const messages = [{
    id: "message-1",
    role: "user",
    content: [{ type: "text", text: "Hello" }],
  }] as unknown as ChatModelRunOptions["messages"]
  return {
    messages,
    runConfig: {} as ChatModelRunOptions["runConfig"],
    abortSignal,
    context: {} as ChatModelRunOptions["context"],
    unstable_getMessage: () => messages[0],
  }
}

async function collectRun(
  adapter: ChatModelAdapter,
  options = runOptions()
): Promise<ChatModelRunResult[]> {
  const result = adapter.run(options)
  if (!(Symbol.asyncIterator in result)) {
    throw new Error("Polling adapter must return an async generator")
  }
  const updates: ChatModelRunResult[] = []
  for await (const update of result) updates.push(update)
  return updates
}

function jobResponse(overrides: Record<string, unknown> = {}): Response {
  return mockResponse({
    jobId: "job-1",
    conversationId: "conversation-1",
    status: "completed",
    responseData: {
      text: "Done",
      finishReason: "stop",
    },
    pollingInterval: 1,
    shouldContinuePolling: false,
    requestId: "request-1",
    ...overrides,
  })
}

function mockResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: {
      get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
    json: async () => body,
  } as unknown as Response
}

describe("Nexus polling adapter", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = fetchMock as typeof fetch
  })

  it("submits converted messages and yields partial plus final content", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(
        { jobId: "job-1" },
        202,
        { "X-Conversation-Id": "conversation-2" }
      ))
      .mockResolvedValueOnce(jobResponse({ partialContent: "Working" }))
    const onConversationIdChange = jest.fn()
    const adapter = createNexusPollingAdapter({
      apiUrl: "/api/nexus/chat",
      bodyFn: () => ({ mode: "standard" }),
      onConversationIdChange,
    })

    const updates = await collectRun(adapter)

    expect(updates).toEqual([
      { content: [{ type: "text", text: "Working" }] },
      { content: [{ type: "text", text: "Done" }] },
    ])
    expect(onConversationIdChange).toHaveBeenCalledWith("conversation-2")
    const request = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(request?.body))).toEqual(expect.objectContaining({
      mode: "standard",
      messages: [expect.objectContaining({
        parts: [{ type: "text", text: "Hello" }],
      })],
    }))
  })

  it("carries the server conversation id into the next submission", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(
        { jobId: "job-1" },
        202,
        { "X-Conversation-Id": "conversation-2" }
      ))
      .mockResolvedValueOnce(jobResponse())
      .mockResolvedValueOnce(mockResponse({ jobId: "job-2" }, 202))
      .mockResolvedValueOnce(jobResponse())
    const adapter = createNexusPollingAdapter({ apiUrl: "/api/nexus/chat" })

    await collectRun(adapter)
    await collectRun(adapter)

    const secondSubmission = fetchMock.mock.calls[2]?.[1]
    expect(JSON.parse(String(secondSubmission?.body))).toEqual(
      expect.objectContaining({ conversationId: "conversation-2" })
    )
  })

  it("sends a cancellation request when the run is aborted after submission", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ jobId: "job-1" }, 202))
      .mockResolvedValueOnce(mockResponse(null, 204))
    const controller = new AbortController()
    controller.abort()
    const adapter = createNexusPollingAdapter({ apiUrl: "/api/nexus/chat" })

    await expect(collectRun(adapter, runOptions(controller.signal))).resolves.toEqual([])

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/nexus/chat/jobs/job-1",
      expect.objectContaining({ method: "DELETE" })
    )
  })
})
