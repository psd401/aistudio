import {
  afterEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals"

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
}))

import {
  UniversalPollingAdapter,
  type JobPollingResponse,
} from "@/lib/streaming/universal-polling-adapter"

function pollingResponse(
  overrides: Partial<JobPollingResponse> = {},
): JobPollingResponse {
  return {
    jobId: "job-1",
    conversationId: 42,
    status: "completed",
    createdAt: "2026-07-27T00:00:00.000Z",
    expiresAt: "2026-07-27T01:00:00.000Z",
    partialContent: "partial",
    progressInfo: {},
    responseData: {
      text: "final",
      finishReason: "stop",
    },
    pollingInterval: 1,
    shouldContinuePolling: false,
    requestId: "request-1",
    ...overrides,
  }
}

async function collectUpdates(
  adapter: UniversalPollingAdapter,
): Promise<string[]> {
  const updates: string[] = []
  for await (const update of adapter.pollJob("job-1")) {
    updates.push(update.content)
  }
  return updates
}

function mockResponse(options: {
  status: number;
  statusText?: string;
  body?: JobPollingResponse;
}): Response {
  const { status, statusText = "", body } = options
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response
}

describe("UniversalPollingAdapter", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "fetch")
  })

  it("emits partial and final content for a completed job", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockResponse({ status: 200, body: pollingResponse() }))
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    })

    await expect(collectUpdates(new UniversalPollingAdapter())).resolves.toEqual([
      "partial",
      "final",
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("preserves the specific error for a missing job", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        mockResponse({ status: 404, statusText: "Not Found" }),
      )
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    })

    await expect(
      collectUpdates(new UniversalPollingAdapter()),
    ).rejects.toThrow("Job not found")
  })
})
