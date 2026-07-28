/** @jest-environment node */

const authenticatePollingRequestMock = jest.fn()
const validateJobOwnershipMock = jest.fn()
const getJobMock = jest.fn()
const getOptimalPollingIntervalMock = jest.fn()
const cancelJobMock = jest.fn()
const executeQueryMock = jest.fn()
const upsertMessageWithStatsMock = jest.fn()

jest.mock("@/lib/auth/optimized-polling-auth", () => ({
  authenticatePollingRequest: (...args: unknown[]) =>
    authenticatePollingRequestMock(...args),
  validateJobOwnership: (...args: unknown[]) =>
    validateJobOwnershipMock(...args),
}))

jest.mock("@/lib/streaming/job-management-service", () => ({
  jobManagementService: {
    cancelJob: (...args: unknown[]) => cancelJobMock(...args),
    getJob: (...args: unknown[]) => getJobMock(...args),
    getOptimalPollingInterval: (...args: unknown[]) =>
      getOptimalPollingIntervalMock(...args),
  },
}))

jest.mock("@/lib/db/drizzle", () => ({
  upsertMessageWithStats: (...args: unknown[]) =>
    upsertMessageWithStatsMock(...args),
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}))

jest.mock("@/lib/db/schema", () => ({
  nexusMessages: {
    conversationId: "conversationId",
    createdAt: "createdAt",
    id: "id",
    role: "role",
  },
}))

jest.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  gte: (...args: unknown[]) => ({ gte: args }),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
  generateRequestId: () => "request-1",
  startTimer: () => jest.fn(),
}))

import { GET } from "@/app/api/nexus/chat/jobs/[jobId]/route"

const params = { params: Promise.resolve({ jobId: "job-1" }) }
const originalResponse = globalThis.Response

class RouteTestHeaders extends Map<string, string> {
  override get(name: string): string | undefined {
    const normalized = name.toLowerCase()
    return [...this].find(([key]) => key.toLowerCase() === normalized)?.[1]
  }
}

class RouteTestResponse {
  readonly headers: RouteTestHeaders
  readonly status: number

  constructor(
    private readonly responseBody: BodyInit | null | undefined,
    init: ResponseInit = {}
  ) {
    this.status = init.status ?? 200
    this.headers = new RouteTestHeaders(
      Object.entries(
        (init.headers ?? {}) as Record<string, string>
      )
    )
  }

  async json(): Promise<unknown> {
    return JSON.parse(String(this.responseBody)) as unknown
  }
}

function responseHeader(response: Response, name: string): string | null {
  const direct = response.headers.get(name)
  if (direct !== undefined && direct !== null) return direct
  const entries = Object.fromEntries(response.headers.entries())
  return entries[name] ?? entries[name.toLowerCase()] ?? null
}

function job(status: "pending" | "completed") {
  return {
    id: "job-1",
    completedAt: status === "completed" ? new Date("2026-01-01T00:01:00Z") : null,
    conversationId: "conversation-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    errorMessage: null,
    expiresAt: new Date("2026-01-01T01:00:00Z"),
    modelId: "model-1",
    nexusConversationId: "nexus-conversation-1",
    partialContent: status === "pending" ? "partial" : "complete",
    progressInfo: { step: 1 },
    responseData:
      status === "completed"
        ? {
            text: "Finished response",
            usage: { totalTokens: 12 },
            finishReason: "stop",
          }
        : null,
    startedAt: new Date("2026-01-01T00:00:10Z"),
    status,
    userId: "user-1",
  }
}

describe("Nexus job polling route", () => {
  beforeAll(() => {
    globalThis.Response = RouteTestResponse as unknown as typeof Response
  })

  afterAll(() => {
    globalThis.Response = originalResponse
  })

  beforeEach(() => {
    jest.clearAllMocks()
    authenticatePollingRequestMock.mockResolvedValue({
      authMethod: "cache",
      authTime: 2,
      isAuthorized: true,
      userId: "user-1",
    })
    validateJobOwnershipMock.mockReturnValue({ authorized: true })
    getJobMock.mockResolvedValue(job("pending"))
    getOptimalPollingIntervalMock.mockResolvedValue(1500)
    executeQueryMock.mockResolvedValue([])
    upsertMessageWithStatsMock.mockResolvedValue(undefined)
  })

  it("rejects unauthenticated polls before loading the job", async () => {
    authenticatePollingRequestMock.mockResolvedValue({
      authMethod: "session",
      authTime: 4,
      isAuthorized: false,
    })

    const response = await GET(new Request("http://localhost"), params)

    expect(response.status).toBe(401)
    expect(getJobMock).not.toHaveBeenCalled()
  })

  it("rejects a job owned by another user", async () => {
    validateJobOwnershipMock.mockReturnValue({
      authorized: false,
      reason: "owner-mismatch",
    })

    const response = await GET(new Request("http://localhost"), params)

    expect(response.status).toBe(403)
    expect(getOptimalPollingIntervalMock).not.toHaveBeenCalled()
  })

  it("returns active polling guidance without attempting persistence", async () => {
    const response = await GET(new Request("http://localhost"), params)

    expect(response.status).toBe(200)
    expect(responseHeader(response, "Cache-Control")).toContain("no-store")
    expect(await response.json()).toMatchObject({
      jobId: "job-1",
      partialContent: "partial",
      pollingInterval: 1500,
      shouldContinuePolling: true,
      status: "pending",
    })
    expect(executeQueryMock).not.toHaveBeenCalled()
    expect(upsertMessageWithStatsMock).not.toHaveBeenCalled()
  })

  it("idempotently persists a completed assistant response", async () => {
    getJobMock.mockResolvedValue(job("completed"))

    const response = await GET(new Request("http://localhost"), params)

    expect(response.status).toBe(200)
    expect(responseHeader(response, "Cache-Control")).toBe(
      "private, max-age=60"
    )
    expect(upsertMessageWithStatsMock).toHaveBeenCalledWith(
      "job-job-1",
      "nexus-conversation-1",
      expect.objectContaining({
        content: "Finished response",
        finishReason: "stop",
        metadata: { savedVia: "api-fallback", jobId: "job-1" },
        role: "assistant",
      })
    )
    expect(await response.json()).toMatchObject({
      responseData: { text: "Finished response" },
      shouldContinuePolling: false,
      status: "completed",
    })
  })

  it("does not persist a duplicate completed response", async () => {
    getJobMock.mockResolvedValue(job("completed"))
    executeQueryMock.mockResolvedValue([{ id: "existing-message" }])

    const response = await GET(new Request("http://localhost"), params)

    expect(response.status).toBe(200)
    expect(upsertMessageWithStatsMock).not.toHaveBeenCalled()
  })
})
