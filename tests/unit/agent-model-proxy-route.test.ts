/** @jest-environment node */

import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

const verifyContextMock = jest.fn<() => Promise<
  | {
      ownerEmail: string
      actorEmail: string
      mode: "owner"
      sessionId: string
    }
  | null
>>()
const getSecretStringMock = jest.fn<() => Promise<string | null>>()
const fetchMock = jest.fn<typeof fetch>()

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: verifyContextMock,
}))
jest.mock("@/lib/agent-workspace/secrets-manager", () => ({
  getSecretString: getSecretStringMock,
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => "request-id",
  sanitizeForLogging: (value: unknown) => value,
}))

function request(body: unknown) {
  const bytes = Buffer.from(JSON.stringify(body))
  return {
    headers: new Map<string, string>([
      ["content-length", String(bytes.byteLength)],
      ["accept", "application/json"],
    ]),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    signal: new AbortController().signal,
  }
}

describe("Agent model credential broker", () => {
  let POST: typeof import("@/app/api/agent/model-proxy/[...path]/route").POST

  beforeAll(async () => {
    ({ POST } = await import("@/app/api/agent/model-proxy/[...path]/route"))
    global.fetch = fetchMock
  })

  beforeEach(() => {
    jest.clearAllMocks()
    verifyContextMock.mockResolvedValue({
      ownerEmail: "owner@example.com",
      actorEmail: "owner@example.com",
      mode: "owner",
      sessionId: "session-id",
    })
    getSecretStringMock.mockResolvedValue("trusted-web-tier-api-key")
    fetchMock.mockResolvedValue(
      new Response("provider response", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  })

  it("requires a signed owner or scheduled invocation before reading the key", async () => {
    verifyContextMock.mockResolvedValueOnce(null)

    const response = await POST(
      request({}) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )

    expect(response.status).toBe(403)
    expect(getSecretStringMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects unapproved endpoints, models, and output limits", async () => {
    const wrongPath = await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 100,
      }) as never,
      { params: Promise.resolve({ path: ["arbitrary"] }) },
    )
    expect(wrongPath.status).toBe(404)

    const wrongModel = await POST(
      request({ model: "attacker/model", max_tokens: 100 }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )
    expect(wrongModel.status).toBe(400)

    const oversizedOutput = await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 32_769,
      }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )
    expect(oversizedOutput.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("adds the bearer-equivalent API key only at the fixed trusted upstream", async () => {
    const response = await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 1_024,
        messages: [{ role: "user", content: "hello" }],
      }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          "x-api-key": "trusted-web-tier-api-key",
        }),
      }),
    )
  })
})
