/** @jest-environment node */

const getServerSessionMock = jest.fn()
const getCurrentUserActionMock = jest.fn()
const getModelConfigMock = jest.fn()
const filterAccessibleResourceIdsMock = jest.fn()
const streamMock = jest.fn()

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => getServerSessionMock(...args),
}))

jest.mock("@/actions/db/get-current-user-action", () => ({
  getCurrentUserAction: (...args: unknown[]) =>
    getCurrentUserActionMock(...args),
}))

jest.mock("@/lib/ai/model-config", () => ({
  getModelConfig: (...args: unknown[]) => getModelConfigMock(...args),
}))

jest.mock("@/lib/db/drizzle/resource-access", () => ({
  filterAccessibleResourceIds: (...args: unknown[]) =>
    filterAccessibleResourceIdsMock(...args),
}))

jest.mock("@/lib/streaming/unified-streaming-service", () => ({
  unifiedStreamingService: {
    stream: (...args: unknown[]) => streamMock(...args),
  },
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
  generateRequestId: () => "request-1",
  startTimer: () => jest.fn(),
}))

import { POST } from "@/app/api/compare-models/route"

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/compare-models", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

const validBody = {
  model1Id: 1,
  model2Id: 2,
  prompt: "Compare these models",
}

describe("compare models route", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getServerSessionMock.mockResolvedValue({ sub: "session-1" })
    getCurrentUserActionMock.mockResolvedValue({
      data: { user: { id: 7 } },
      isSuccess: true,
    })
    getModelConfigMock
      .mockResolvedValueOnce({ id: 1, model_id: "model-1", provider: "openai" })
      .mockResolvedValueOnce({ id: 2, model_id: "model-2", provider: "google" })
    filterAccessibleResourceIdsMock.mockResolvedValue(new Set(["1", "2"]))
    streamMock.mockImplementation(async (streamRequest) => {
      await streamRequest.callbacks.onFinish({ usage: { totalTokens: 3 } })
    })
  })

  it("rejects malformed input before authentication", async () => {
    const response = await POST(request({ ...validBody, prompt: "" }))

    expect(response.status).toBe(400)
    expect(getServerSessionMock).not.toHaveBeenCalled()
  })

  it("rejects a model outside the user's resource grants", async () => {
    filterAccessibleResourceIdsMock.mockResolvedValue(new Set(["1"]))

    const response = await POST(request(validBody))

    expect(response.status).toBe(403)
    expect(streamMock).not.toHaveBeenCalled()
  })

  it("streams both accessible models and closes with a done event", async () => {
    const response = await POST(request(validBody))
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(body).toContain('"model1Finished":true')
    expect(body).toContain('"model2Finished":true')
    expect(body).toContain('"done":true')
  })
})
